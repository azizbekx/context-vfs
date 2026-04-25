from __future__ import annotations

import csv
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .storage import Store
from .utils import as_list, clean_text, rel_path, slugify, stable_hash, stable_id

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class BuildStats:
    sources_seen: int = 0
    sources_changed: int = 0
    entities: int = 0
    facts: int = 0
    reviews: int = 0

    def add(
        self,
        *,
        sources_seen: int = 0,
        sources_changed: int = 0,
        entities: int = 0,
        facts: int = 0,
        reviews: int = 0,
    ) -> "BuildStats":
        return BuildStats(
            self.sources_seen + sources_seen,
            self.sources_changed + sources_changed,
            self.entities + entities,
            self.facts + facts,
            self.reviews + reviews,
        )


class ContextBuilder:
    def __init__(
        self,
        store: Store,
        dataset_dir: Path,
        run_id: str,
        *,
        force: bool = False,
        use_llm: bool = False,
        schema: dict | None = None,
    ):
        self.store = store
        self.dataset_dir = dataset_dir
        self.run_id = run_id
        self.force = force
        self.use_llm = use_llm
        self.schema = schema
        self.stats = BuildStats()
        self._pending_policy_knowledge: dict[str, dict[str, Any]] = {}

    def build(self) -> BuildStats:
        extractors: list[Callable[[], None]] = [
            self.extract_employees,
            self.extract_resumes,
            self.extract_emails,
            self.extract_conversations,
            self.extract_posts,
            self.extract_github,
            self.extract_policies,
            self.extract_overflow,
        ]
        for extractor in extractors:
            try:
                extractor()
            except Exception as exc:
                logger.warning("Extractor %s failed: %s", extractor.__name__, exc)
        if self.schema:
            try:
                self.extract_from_schema(self.schema)
            except Exception as exc:
                logger.warning("Schema extractor failed: %s", exc)
        self.store.mark_missing_sources_stale(self.run_id)
        cleaned = self.store.cleanup_stale_facts()
        if cleaned:
            logger.info("Cleaned up %d stale facts", cleaned)
        cleaned_entities = self.store.cleanup_orphaned_entities()
        if cleaned_entities:
            logger.info("Cleaned up %d orphaned entities", cleaned_entities)
        self.detect_conflicts()
        self.generate_embeddings()
        self.store.commit()
        return self.stats

    def generate_embeddings(self) -> None:
        if not self.use_llm:
            return
        
        rows = self.store.rows("""
            SELECT e.id, e.name, e.summary 
            FROM entities e 
            LEFT JOIN entity_embeddings ee ON e.id = ee.entity_id 
            WHERE ee.entity_id IS NULL OR ee.text_content != (e.name || ' ' || COALESCE(e.summary, ''))
        """)
        if not rows:
            return
            
        logger.info("Generating embeddings for %d entities...", len(rows))
        try:
            from google import genai
            client = genai.Client()
        except ImportError:
            logger.warning("google-genai not installed or no API key. Skipping embeddings.")
            return

        batch_size = 100
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i+batch_size]
            texts = [f"{r['name']} {r['summary'] or ''}".strip() for r in batch]
            try:
                res = client.models.embed_content(
                    model="gemini-embedding-2", 
                    contents=texts
                )
                for row, emb in zip(batch, res.embeddings):
                    text_content = f"{row['name']} {row['summary'] or ''}".strip()
                    self.store.conn.execute("""
                        INSERT INTO entity_embeddings (entity_id, text_content, embedding_json)
                        VALUES (?, ?, ?)
                        ON CONFLICT(entity_id) DO UPDATE SET
                            text_content = excluded.text_content,
                            embedding_json = excluded.embedding_json
                    """, (row["id"], text_content, json.dumps(emb.values)))
                self.store.conn.commit()
                logger.info("Embedded %d / %d", min(i + len(batch), len(rows)), len(rows))
            except Exception as e:
                logger.error("Embedding batch failed: %s", e)

    def json_records(self, relative: str) -> list[dict[str, Any]]:
        path = self.dataset_dir / relative
        if not path.exists():
            return []
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        if isinstance(data, dict):
            return [data]
        return []

    def csv_records(self, relative: str) -> list[dict[str, Any]]:
        path = self.dataset_dir / relative
        if not path.exists():
            return []
        with path.open("r", encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle))

    def source(
        self,
        relative: str,
        record_id: str,
        kind: str,
        payload: Any,
        raw_ref: str | None = None,
    ) -> tuple[str, bool]:
        state = self.store.upsert_source(
            dataset_path=relative,
            record_id=record_id,
            kind=kind,
            payload=payload,
            raw_ref=raw_ref or f"{relative}#{record_id}",
            run_id=self.run_id,
            force=self.force,
        )
        self.stats = self.stats.add(
            sources_seen=1, sources_changed=1 if state.changed else 0
        )
        return state.id, state.changed

    def entity(
        self,
        entity_id: str,
        entity_type: str,
        name: str,
        path: str | None = None,
        *,
        aliases: list[str] | None = None,
        summary: str | None = None,
        confidence: float = 1.0,
    ) -> str:
        self.store.upsert_entity(
            entity_id=entity_id,
            entity_type=entity_type,
            name=clean_text(name, 180) or entity_id,
            path=path,
            aliases=aliases or [],
            summary=summary,
            confidence=confidence,
        )
        self.stats = self.stats.add(entities=1)
        return entity_id

    def fact(
        self,
        subject_id: str,
        predicate: str,
        source_id: str,
        *,
        value: Any = None,
        object_entity_id: str | None = None,
        confidence: float = 1.0,
        extraction_method: str = "deterministic",
        valid_from: str | None = None,
        valid_to: str | None = None,
    ) -> str | None:
        if value in (None, "") and not object_entity_id:
            return None
        fact_id = self.store.upsert_fact(
            subject_id=subject_id,
            predicate=predicate,
            source_id=source_id,
            run_id=self.run_id,
            value=value,
            object_entity_id=object_entity_id,
            confidence=confidence,
            extraction_method=extraction_method,
            valid_from=valid_from,
            valid_to=valid_to,
        )
        self.stats = self.stats.add(facts=1)
        return fact_id

    def extract_employees(self) -> None:
        relative = "Human_Resource_Management/Employees/employees.json"
        for record in self.json_records(relative):
            emp_id = clean_text(record.get("emp_id"))
            if not emp_id:
                continue
            source_id, changed = self.source(relative, emp_id, "employee", record)
            employee_id = f"employee:{emp_id}"
            self.entity(
                employee_id,
                "employee",
                record.get("Name") or emp_id,
                f"company/employees/{emp_id}.md",
                aliases=[record.get("email", ""), emp_id],
                summary=clean_text(record.get("description"), 420),
            )
            if not changed:
                continue
            fields = {
                "department": "category",
                "experience": "Experience",
                "level": "Level",
                "email": "email",
                "date_of_joining": "DOJ",
                "date_of_leaving": "DOL",
                "salary": "Salary",
                "performance_rating": "Performance Rating",
                "skills": "skills",
                "remaining_casual_leaves": "Remaining Casual Leaves",
                "remaining_sick_leaves": "Remaining Sick Leaves",
                "remaining_vacation_leaves": "Remaining Vacation Leaves",
                "total_leaves_taken": "Total Leaves Taken",
                "is_valid": "is_valid",
            }
            for predicate, key in fields.items():
                self.fact(employee_id, predicate, source_id, value=record.get(key))
            reports_to = clean_text(record.get("reports_to"))
            if reports_to and reports_to.lower() != "none":
                manager_id = f"employee:{reports_to}"
                self.entity(
                    manager_id,
                    "employee",
                    reports_to,
                    f"company/employees/{reports_to}.md",
                    aliases=[reports_to],
                    confidence=0.6,
                )
                self.fact(employee_id, "reports_to", source_id, object_entity_id=manager_id)
            for reportee in as_list(record.get("reportees")):
                reportee_id = f"employee:{reportee}"
                self.entity(
                    reportee_id,
                    "employee",
                    reportee,
                    f"company/employees/{reportee}.md",
                    aliases=[reportee],
                    confidence=0.6,
                )
                self.fact(employee_id, "manages", source_id, object_entity_id=reportee_id)

    def extract_resumes(self) -> None:
        relative = "Human_Resource_Management/Resume/resume_information.csv"
        for record in self.csv_records(relative):
            resume_id = clean_text(record.get("resume_id"))
            emp_id = clean_text(record.get("emp_id"))
            if not resume_id or not emp_id:
                continue
            source_id, changed = self.source(relative, resume_id, "resume", record)
            if not changed:
                continue
            employee_id = f"employee:{emp_id}"
            self.entity(
                employee_id,
                "employee",
                record.get("name") or emp_id,
                f"company/employees/{emp_id}.md",
                aliases=[record.get("email", ""), emp_id],
                summary=clean_text(record.get("content"), 420),
                confidence=0.85,
            )
            self.fact(employee_id, "resume_category", source_id, value=record.get("category"))
            self.fact(employee_id, "resume_content", source_id, value=clean_text(record.get("content"), 900))
            self.fact(employee_id, "resume_file", source_id, value=record.get("file_path"))
            self._review_resume_identity(employee_id, source_id, record)


    def extract_emails(self) -> None:
        relative = "Enterprise_Mail_System/emails.json"
        for record in self.json_records(relative):
            email_id = clean_text(record.get("email_id"))
            if not email_id:
                continue
            source_id, changed = self.source(relative, email_id, "email", record)
            if not changed:
                continue
            thread_id = clean_text(record.get("thread_id")) or email_id
            entity_id = self.entity(
                f"email_thread:{thread_id}",
                "email_thread",
                record.get("subject") or f"Email thread {thread_id}",
                f"company/email-threads/{slugify(thread_id)}.md",
                aliases=[thread_id, record.get("category", "")],
                summary=clean_text(record.get("body"), 420),
            )
            sender = clean_text(record.get("sender_emp_id"))
            recipient = clean_text(record.get("recipient_emp_id"))
            if sender:
                self.fact(entity_id, "sender", source_id, object_entity_id=f"employee:{sender}")
            if recipient:
                self.fact(entity_id, "recipient", source_id, object_entity_id=f"employee:{recipient}")
            self.fact(entity_id, "date", source_id, value=record.get("date"))
            self.fact(entity_id, "subject", source_id, value=record.get("subject"))
            self.fact(entity_id, "category", source_id, value=record.get("category"))
            self.fact(entity_id, "importance", source_id, value=record.get("importance"))
            self.fact(entity_id, "body", source_id, value=clean_text(record.get("body"), 900))
            self._extract_lightweight_work_items(entity_id, source_id, record.get("body"))

    def extract_conversations(self) -> None:
        relative = "Collaboration_tools/conversations.json"
        for record in self.json_records(relative):
            conversation_id = clean_text(record.get("conversation_id"))
            if not conversation_id:
                continue
            source_id, changed = self.source(relative, conversation_id, "conversation", record)
            if not changed:
                continue
            entity_id = self.entity(
                f"conversation:{conversation_id}",
                "conversation",
                f"Conversation {conversation_id}",
                f"company/conversations/{slugify(conversation_id)}.md",
                summary=clean_text(record.get("text"), 420),
            )
            sender = clean_text(record.get("sender_emp_id"))
            recipient = clean_text(record.get("recipient_emp_id"))
            if sender:
                self.fact(entity_id, "sender", source_id, object_entity_id=f"employee:{sender}")
            if recipient:
                self.fact(entity_id, "recipient", source_id, object_entity_id=f"employee:{recipient}")
            self.fact(entity_id, "date", source_id, value=record.get("date"))
            self.fact(entity_id, "text", source_id, value=clean_text(record.get("text"), 900))
            self._extract_lightweight_work_items(entity_id, source_id, record.get("text"))

    def extract_posts(self) -> None:
        relative = "Enterprise_Social_Platform/posts.json"
        for index, record in enumerate(self.json_records(relative), start=1):
            post_id = stable_hash(record)[:16]
            source_id, changed = self.source(relative, str(index), "social_post", record)
            if not changed:
                continue
            entity_id = self.entity(
                f"post:{post_id}",
                "social_post",
                record.get("Title") or f"Post {index}",
                f"company/posts/{post_id}.md",
                summary=clean_text(record.get("Post"), 420),
            )
            emp_id = clean_text(record.get("emp_id"))
            if emp_id:
                self.fact(entity_id, "author", source_id, object_entity_id=f"employee:{emp_id}")
            self.fact(entity_id, "title", source_id, value=record.get("Title"))
            self.fact(entity_id, "post", source_id, value=clean_text(record.get("Post"), 900))
            self._extract_lightweight_work_items(entity_id, source_id, record.get("Post"))

    def extract_github(self) -> None:
        relative = "Workspace/GitHub/GitHub.json"
        for record in self.json_records(relative):
            repo_name = clean_text(record.get("repo_name"))
            path = clean_text(record.get("path"))
            if not repo_name:
                continue
            record_id = f"{repo_name}:{path or record.get('hash', '')}"
            source_id, changed = self.source(relative, record_id, "github_file", record)
            repo_id = f"repo:{slugify(repo_name)}"
            self.entity(
                repo_id,
                "repo",
                repo_name,
                f"company/repos/{slugify(repo_name)}.md",
                aliases=[repo_name, record.get("language", "")],
            )
            if not changed:
                continue
            self.fact(repo_id, "language", source_id, value=record.get("language"))
            self.fact(repo_id, "license", source_id, value=record.get("license"))
            self.fact(repo_id, "file_path", source_id, value=path)
            self.fact(repo_id, "file_size", source_id, value=record.get("size"))
            self.fact(repo_id, "file_hash", source_id, value=record.get("hash"))
            self.fact(repo_id, "creation_date", source_id, value=record.get("creation_date"))
            emp_id = clean_text(record.get("emp_id"))
            if emp_id:
                self.fact(repo_id, "contributor", source_id, object_entity_id=f"employee:{emp_id}")
            issues = record.get("issues")
            if issues:
                self.fact(repo_id, "issues", source_id, value=clean_text(issues, 900))

    def extract_policies(self) -> None:
        policy_dir = self.dataset_dir / "Policy_Documents"
        if not policy_dir.exists():
            return
        for pdf_path in sorted(policy_dir.glob("*.pdf")):
            relative = rel_path(pdf_path, self.dataset_dir)
            try:
                pdf_bytes = pdf_path.read_bytes()
            except OSError:
                continue
            source_id, changed = self.source(
                relative,
                "document",
                "policy_pdf",
                {"sha256": stable_hash(pdf_bytes), "name": pdf_path.name},
                raw_ref=relative,
            )
            policy_name = pdf_path.stem.replace("%20", " ")
            policy_slug = slugify(policy_name.replace("Inazuma.co", "").replace("Inazuma", ""))
            entity_id = f"policy:{policy_slug}"
            text = self._extract_pdf_text(pdf_path) if changed else ""
            summary = self._summarize_policy(policy_name, text)
            self.entity(
                entity_id,
                "policy",
                policy_name,
                f"company/policies/{policy_slug}.md",
                aliases=[policy_slug],
                summary=summary,
                confidence=0.9,
            )
            if not changed:
                continue
            self.fact(entity_id, "source_file", source_id, value=relative)
            self.fact(entity_id, "summary", source_id, value=summary, confidence=0.75, extraction_method="pdf-text")
            for topic in self._policy_topics(policy_name, text):
                self.fact(entity_id, "topic", source_id, value=topic, confidence=0.72, extraction_method="pdf-text")
            self._extract_deterministic_policy_processes(policy_name, entity_id, source_id, text)
        self._extract_policy_processes()

    def _extract_pdf_text(self, pdf_path: Path) -> str:
        try:
            import pymupdf

            doc = pymupdf.open(str(pdf_path))
            chunks = []
            for page in doc:
                text = page.get_text() or ""
                if text.strip():
                    chunks.append(text)
            doc.close()
            return clean_text("\n".join(chunks), 8000)
        except ImportError:
            pass
        try:
            from pypdf import PdfReader

            reader = PdfReader(str(pdf_path))
            chunks = []
            for page in reader.pages[:8]:
                text = page.extract_text() or ""
                if text.strip():
                    chunks.append(text)
            return clean_text(" ".join(chunks), 5000)
        except Exception:
            return ""

    def _summarize_policy(self, policy_name: str, text: str) -> str:
        if self.use_llm and text and len(text.strip()) > 50:
            try:
                from .llm import extract_policy_knowledge

                knowledge = extract_policy_knowledge(policy_name, text)
                summary = knowledge.get("summary", "")
                if summary:
                    self._pending_policy_knowledge[policy_name] = knowledge
                    return clean_text(summary, 420)
            except Exception as exc:
                logger.warning("LLM summary failed for %s: %s", policy_name, exc)
        if not text:
            return f"Policy document: {policy_name}."
        return clean_text(text, 420)

    def _policy_topics(self, policy_name: str, text: str) -> list[str]:
        haystack = f"{policy_name} {text}".lower()
        topics = []
        keywords = {
            "security": ["security", "password", "access", "breach", "data protection"],
            "hr": ["leave", "employee", "performance", "medical", "harassment"],
            "compliance": ["compliance", "governance", "companies act", "ethics"],
            "engineering": ["software", "development", "sdlc", "code"],
            "finance": ["travel", "expense", "reimbursement", "asset"],
            "environment": ["environment", "sustainability", "ecological"],
        }
        for topic, terms in keywords.items():
            if any(term in haystack for term in terms):
                topics.append(topic)
        return topics or ["general"]

    def _extract_lightweight_work_items(self, source_entity_id: str, source_id: str, text: Any) -> None:
        body = clean_text(text, 1000)
        lowered = body.lower()
        work_terms = ("project", "task", "deadline", "blocked", "status", "milestone", "launch")
        if not body or not any(term in lowered for term in work_terms):
            return
        work_id = stable_id("work_item", source_entity_id, body, length=18)
        title = clean_text(body, 72)
        self.entity(
            work_id,
            "work_item",
            title,
            f"company/work-items/{work_id.replace(':', '-')}.md",
            summary=body,
            confidence=0.62,
        )
        self.fact(source_entity_id, "mentions_work_item", source_id, object_entity_id=work_id, confidence=0.62)
        self.fact(work_id, "evidence", source_id, value=body, confidence=0.62, extraction_method="heuristic")
        owner_match = re.search(r"\b(?:owner|assigned to|by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})", body)
        date_match = re.search(r"\b(?:by|deadline|due)\s+([A-Z][a-z]+ \d{1,2}|\d{4}-\d{2}-\d{2})", body, re.IGNORECASE)
        if date_match:
            self.fact(work_id, "deadline", source_id, value=date_match.group(1), confidence=0.58, extraction_method="heuristic")
        if "blocked" in lowered or "blocker" in lowered:
            self.fact(work_id, "status", source_id, value="blocked", confidence=0.60, extraction_method="heuristic")
            self.fact(work_id, "blocker", source_id, value=body, confidence=0.55, extraction_method="heuristic")
        elif "on track" in lowered:
            self.fact(work_id, "status", source_id, value="on track", confidence=0.58, extraction_method="heuristic")
        if owner_match:
            self.fact(work_id, "owner_hint", source_id, value=owner_match.group(1), confidence=0.52, extraction_method="heuristic")

        if "project" in lowered or "launch" in lowered or "milestone" in lowered:
            project_title = self._project_title(body)
            project_id = f"project:{slugify(project_title)}"
            self.entity(
                project_id,
                "project",
                project_title,
                f"company/projects/{slugify(project_title)}.md",
                summary=body,
                confidence=0.58,
            )
            self.fact(work_id, "part_of_project", source_id, object_entity_id=project_id, confidence=0.58, extraction_method="heuristic")
            self.fact(project_id, "evidence", source_id, value=body, confidence=0.55, extraction_method="heuristic")

        if "task" in lowered or "deadline" in lowered or "blocked" in lowered:
            task_id = stable_id("task", source_entity_id, body, length=18)
            self.entity(
                task_id,
                "task",
                title,
                f"company/tasks/{task_id.replace(':', '-')}.md",
                summary=body,
                confidence=0.58,
            )
            self.fact(task_id, "evidence", source_id, value=body, confidence=0.55, extraction_method="heuristic")
            self.fact(task_id, "derived_from", source_id, object_entity_id=work_id, confidence=0.58, extraction_method="heuristic")

    def _project_title(self, text: str) -> str:
        match = re.search(r"([A-Z][A-Za-z0-9& -]{2,80}?\s+(?:project|launch|milestone))", text, re.IGNORECASE)
        if match:
            return clean_text(match.group(1), 80).title()
        return clean_text(text, 48).title()

    def _extract_deterministic_policy_processes(
        self,
        policy_name: str,
        policy_entity_id: str,
        source_id: str,
        text: str,
    ) -> None:
        haystack = f"{policy_name} {text}".lower()
        templates = [
            (
                ("password",),
                "Password reset and access recovery",
                "User cannot access a system or needs password recovery.",
                ["Verify requester identity.", "Reset credentials using approved tooling.", "Require secure password update.", "Record completion and notify requester."],
            ),
            (
                ("data breach", "breach"),
                "Data breach response",
                "Potential or confirmed data breach is reported.",
                ["Triage the incident.", "Contain affected systems or data.", "Notify responsible security/compliance owners.", "Document impact and required notifications."],
            ),
            (
                ("leave",),
                "Leave request approval",
                "Employee requests time off.",
                ["Employee submits leave request.", "Manager checks entitlement and staffing impact.", "Approve or reject request.", "Update HR leave balance."],
            ),
            (
                ("expense", "reimbursement", "travel"),
                "Expense reimbursement",
                "Employee submits business expense or travel claim.",
                ["Collect receipts and business purpose.", "Validate against reimbursement policy.", "Approve claim.", "Record payment status."],
            ),
            (
                ("asset",),
                "IT asset assignment",
                "Employee needs a company device or asset change.",
                ["Confirm asset request.", "Assign approved asset.", "Update asset register.", "Collect or retire asset when no longer needed."],
            ),
            (
                ("incident", "security", "acceptable use"),
                "Security incident escalation",
                "Suspicious activity or policy violation is detected.",
                ["Capture incident evidence.", "Escalate to security owner.", "Mitigate immediate risk.", "Track follow-up actions."],
            ),
        ]
        for keywords, name, trigger, steps in templates:
            if not any(keyword in haystack for keyword in keywords):
                continue
            slug = slugify(name)
            process_id = f"process:{slug}"
            self.entity(
                process_id,
                "process",
                name,
                f"company/processes/{slug}.md",
                summary=f"Deterministic process extracted from {policy_name}.",
                confidence=0.66,
            )
            self.fact(process_id, "source_policy", source_id, object_entity_id=policy_entity_id, confidence=0.66, extraction_method="deterministic-policy")
            self.fact(process_id, "trigger", source_id, value=trigger, confidence=0.66, extraction_method="deterministic-policy")
            for idx, step in enumerate(steps, start=1):
                self.fact(process_id, f"step_{idx}", source_id, value=step, confidence=0.64, extraction_method="deterministic-policy")

    def detect_conflicts(self) -> None:
        rows = self.store.rows(
            """
            SELECT subject_id, predicate, COUNT(DISTINCT value) AS value_count
            FROM facts
            WHERE status IN ('generated', 'confirmed')
              AND object_entity_id IS NULL
              AND value IS NOT NULL
              AND confidence >= 0.8
              AND predicate IN ('name', 'email', 'department', 'priority', 'poc_status', 'current_poc_product')
            GROUP BY subject_id, predicate
            HAVING value_count > 1
            """
        )
        for row in rows:
            facts = self.store.rows(
                """
                SELECT f.id, f.subject_id, f.predicate, f.value, f.confidence, s.dataset_path, s.record_id
                FROM facts f
                JOIN source_records s ON s.id = f.source_id
                WHERE f.subject_id = ? AND f.predicate = ? AND f.status IN ('generated', 'confirmed')
                ORDER BY f.confidence DESC, s.dataset_path
                """,
                (row["subject_id"], row["predicate"]),
            )
            winner_id = self._auto_resolve(list(facts))
            if winner_id:
                loser_ids = [f["id"] for f in facts if f["id"] != winner_id]
                self.store.auto_resolve_conflict(winner_id, loser_ids)
                logger.info(
                    "Auto-resolved %s/%s: winner=%s losers=%d",
                    row["subject_id"],
                    row["predicate"],
                    winner_id,
                    len(loser_ids),
                )
                continue
            candidates = []
            for index, fact in enumerate(facts, start=1):
                candidates.append(
                    {
                        "choice_id": f"choice-{index}",
                        "fact_id": fact["id"],
                        "value": fact["value"],
                        "confidence": fact["confidence"],
                        "source": f"{fact['dataset_path']}#{fact['record_id']}",
                    }
                )
            review_id = stable_id("review", row["subject_id"], row["predicate"], candidates, length=18)
            self.store.upsert_review(
                review_id=review_id,
                entity_id=row["subject_id"],
                conflict_type="fact_value_conflict",
                predicate=row["predicate"],
                candidates=candidates,
                suggested_resolution="Choose the source of truth or keep the highest-confidence current system value.",
            )
            self.stats = self.stats.add(reviews=1)

    def _auto_resolve(self, facts: list[dict[str, Any]]) -> str | None:
        if len(facts) <= 1:
            return facts[0]["id"] if facts else None
        values = [f["value"] for f in facts if f["value"]]
        if not values:
            return facts[0]["id"]
        normalized = {v.strip().lower() for v in values}
        if len(normalized) == 1:
            return max(facts, key=lambda f: f["confidence"])["id"]
        preferred = self._source_of_truth_winner(facts)
        if preferred:
            return preferred
        non_empty = [
            f
            for f in facts
            if f["value"]
            and f["value"].strip()
            and f["value"].strip().lower() not in ("none", "null", "n/a", "-", "")
        ]
        if len(non_empty) == 1:
            return non_empty[0]["id"]
        return None

    def _source_of_truth_winner(self, facts: list[dict[str, Any]]) -> str | None:
        if not facts:
            return None
        predicate = facts[0]["predicate"]
        subject_id = clean_text(facts[0]["subject_id"])
        source_rules = []
        if subject_id.startswith("employee:") and predicate in {
            "name",
            "email",
            "department",
            "reports_to",
            "level",
        }:
            source_rules = ["Human_Resource_Management/Employees/"]
        elif subject_id.startswith("ticket:") and predicate in {
            "priority",
            "status",
            "assigned_to",
            "assigned_date",
        }:
            source_rules = ["IT_Service_Management/"]
        elif subject_id.startswith(("customer:", "client:")) and predicate in {
            "owner",
            "business_representative",
            "poc_status",
            "current_poc_product",
        }:
            source_rules = ["Customer_Relation_Management/", "Business_and_Management/"]
        elif subject_id.startswith("policy:"):
            source_rules = ["Policy_Documents/"]
        if not source_rules:
            return None

        candidates = [
            fact
            for fact in facts
            if any(str(fact["dataset_path"]).startswith(prefix) for prefix in source_rules)
        ]
        if len(candidates) == 1:
            return candidates[0]["id"]
        return None

    def _review_resume_identity(
        self,
        employee_id: str,
        resume_source_id: str,
        record: dict[str, Any],
    ) -> None:
        employee = self.store.row("SELECT name, aliases_json FROM entities WHERE id = ?", (employee_id,))
        if not employee:
            return
        hr_name = clean_text(employee["name"])
        resume_name = clean_text(record.get("name"))
        aliases = json.loads(employee["aliases_json"] or "[]")
        hr_email = clean_text(next((alias for alias in aliases if "@" in alias), ""))
        resume_email = clean_text(record.get("email"))
        name_conflict = resume_name and hr_name and resume_name.lower() != hr_name.lower()
        email_conflict = resume_email and hr_email and resume_email.lower() != hr_email.lower()
        if not name_conflict and not email_conflict:
            return

        resume_source = self.store.row(
            "SELECT dataset_path, record_id FROM source_records WHERE id = ?",
            (resume_source_id,),
        )
        hr_fact = self.store.row(
            """
            SELECT f.id, s.dataset_path, s.record_id
            FROM facts f
            JOIN source_records s ON s.id = f.source_id
            WHERE f.subject_id = ? AND f.predicate = 'email'
            ORDER BY f.confidence DESC
            LIMIT 1
            """,
            (employee_id,),
        )
        candidates = [
            {
                "choice_id": "keep-hr",
                "fact_id": hr_fact["id"] if hr_fact else None,
                "value": f"HR: {hr_name} <{hr_email or 'no email'}>",
                "confidence": 1.0,
                "source": (
                    f"{hr_fact['dataset_path']}#{hr_fact['record_id']}"
                    if hr_fact
                    else "Human_Resource_Management/Employees"
                ),
            },
            {
                "choice_id": "investigate-resume",
                "fact_id": None,
                "value": f"Resume: {resume_name or 'unknown'} <{resume_email or 'no email'}>",
                "confidence": 0.85,
                "source": (
                    f"{resume_source['dataset_path']}#{resume_source['record_id']}"
                    if resume_source
                    else "Human_Resource_Management/Resume"
                ),
            },
        ]
        review_id = stable_id("review", employee_id, "identity_mismatch", resume_source_id, length=18)
        self.store.upsert_review(
            review_id=review_id,
            entity_id=employee_id,
            conflict_type="identity_mismatch",
            predicate="identity",
            candidates=candidates,
            suggested_resolution=(
                "HR remains the source of truth for employee identity. "
                "Investigate whether the resume is attached to the wrong employee or should become an alias."
            ),
        )
        self.stats = self.stats.add(reviews=1)

    def extract_from_schema(self, schema: dict[str, Any]) -> None:
        for source_config in schema.get("sources", []):
            path = source_config.get("path", "")
            fmt = source_config.get("format", "json")
            id_field = source_config.get("id_field", "id")
            entity_type = source_config.get("entity_type", "generic")
            name_field = source_config.get("name_field", id_field)
            summary_field = source_config.get("summary_field")
            path_template = source_config.get(
                "path_template", "company/{type}/{id}.md"
            )
            alias_fields = source_config.get("alias_fields", [])
            fact_mappings = source_config.get("facts", [])

            records = (
                self.json_records(path) if fmt == "json" else self.csv_records(path)
            )
            for record in records:
                record_id = clean_text(record.get(id_field))
                if not record_id:
                    continue
                source_id, changed = self.source(path, record_id, entity_type, record)
                entity_id = f"{entity_type}:{record_id}"
                format_values = {
                    str(key): value
                    for key, value in record.items()
                    if str(key) not in {"type", "id"}
                }
                entity_path = path_template.format(
                    type=slugify(entity_type),
                    id=slugify(record_id),
                    **format_values,
                )
                self.entity(
                    entity_id,
                    entity_type,
                    record.get(name_field, record_id),
                    entity_path,
                    aliases=[record.get(f, "") for f in alias_fields],
                    summary=(
                        clean_text(record.get(summary_field), 420)
                        if summary_field
                        else None
                    ),
                )
                if not changed:
                    continue
                for mapping in fact_mappings:
                    field = mapping.get("field", "")
                    predicate = mapping.get("predicate", field)
                    entity_ref = mapping.get("entity_ref")
                    if entity_ref:
                        ref_value = clean_text(record.get(field))
                        if ref_value:
                            prefix = entity_ref.get("prefix", entity_type)
                            tpl = entity_ref.get(
                                "id_template", "{prefix}:{value}"
                            )
                            ref_id = tpl.format(prefix=prefix, value=ref_value)
                            self.entity(
                                ref_id,
                                prefix,
                                ref_value,
                                None,
                                confidence=0.7,
                            )
                            self.fact(
                                entity_id,
                                predicate,
                                source_id,
                                object_entity_id=ref_id,
                                confidence=0.85,
                            )
                    else:
                        self.fact(
                            entity_id, predicate, source_id, value=record.get(field)
                        )

    def _extract_policy_processes(self) -> None:
        if not self._pending_policy_knowledge:
            return
        for policy_name, knowledge in self._pending_policy_knowledge.items():
            policy_slug = slugify(policy_name.replace("Inazuma.co", "").replace("Inazuma", ""))
            policy_entity_id = f"policy:{policy_slug}"
            source_id = self.store.row(
                "SELECT s.id FROM source_records s JOIN facts f ON f.source_id = s.id WHERE f.subject_id = ? LIMIT 1",
                (policy_entity_id,),
            )
            source_id = source_id["id"] if source_id else None
            if not source_id:
                continue
            for definition in knowledge.get("definitions", []):
                term = clean_text(definition.get("term", ""), 120)
                defn = clean_text(definition.get("definition", ""), 420)
                if term and defn:
                    self.fact(
                        policy_entity_id,
                        f"defines:{slugify(term)}",
                        source_id,
                        value=f"{term}: {defn}",
                        confidence=0.72,
                        extraction_method="llm",
                    )
            for role_data in knowledge.get("roles", []):
                role_name = clean_text(role_data.get("role", ""), 120)
                responsibilities = role_data.get("responsibilities", [])
                if role_name and responsibilities:
                    self.fact(
                        policy_entity_id,
                        f"role:{slugify(role_name)}",
                        source_id,
                        value=f"{role_name}: {'; '.join(str(r) for r in responsibilities[:5])}",
                        confidence=0.72,
                        extraction_method="llm",
                    )
            for rule_data in knowledge.get("rules", []):
                rule = clean_text(rule_data.get("rule", ""), 300)
                applies_to = clean_text(rule_data.get("applies_to", ""), 120)
                if rule:
                    self.fact(
                        policy_entity_id,
                        "rule",
                        source_id,
                        value=f"{rule}{f' (applies to: {applies_to})' if applies_to else ''}",
                        confidence=0.72,
                        extraction_method="llm",
                    )
            for proc in knowledge.get("processes", []):
                proc_name = clean_text(proc.get("name", ""), 120)
                if not proc_name:
                    continue
                proc_slug = slugify(f"{policy_slug}-{proc_name}")
                proc_entity = f"process:{proc_slug}"
                self.entity(
                    proc_entity,
                    "process",
                    proc_name,
                    f"company/processes/{proc_slug}.md",
                    summary=clean_text(f"Process from {policy_name}: {proc_name}", 420),
                    confidence=0.72,
                )
                self.fact(proc_entity, "source_policy", source_id, object_entity_id=policy_entity_id, confidence=0.72, extraction_method="llm")
                responsible = clean_text(proc.get("responsible_role", ""), 120)
                if responsible:
                    self.fact(proc_entity, "responsible_role", source_id, value=responsible, confidence=0.72, extraction_method="llm")
                trigger = clean_text(proc.get("trigger", ""), 300)
                if trigger:
                    self.fact(proc_entity, "trigger", source_id, value=trigger, confidence=0.72, extraction_method="llm")
                steps = proc.get("steps", [])
                for idx, step in enumerate(steps, 1):
                    step_text = clean_text(str(step), 300)
                    if step_text:
                        self.fact(proc_entity, f"step_{idx}", source_id, value=step_text, confidence=0.70, extraction_method="llm")
                self.stats = self.stats.add(entities=1)
        self._pending_policy_knowledge.clear()

    def extract_overflow(self) -> None:
        relative = "Inazuma_overflow/overflow.json"
        for record in self.json_records(relative):
            record_id = clean_text(record.get("id") or record.get("title") or record.get("name"))
            if not record_id:
                record_id = stable_hash(record)[:16]
            source_id, changed = self.source(relative, str(record_id), "overflow", record)
            overflow_type = clean_text(record.get("type", ""), 60) or "overflow"
            title = clean_text(record.get("title") or record.get("name") or record_id, 180)
            entity_id = f"overflow:{slugify(f'{overflow_type}-{record_id}')}"
            self.entity(
                entity_id,
                "overflow",
                title,
                f"company/overflow/{slugify(f'{overflow_type}-{record_id}')}.md",
                summary=clean_text(record.get("content") or record.get("description") or record.get("body") or "", 420),
                confidence=0.65,
            )
            if not changed:
                continue
            self.fact(entity_id, "overflow_type", source_id, value=overflow_type)
            for key in ("title", "name", "content", "description", "body", "category", "status", "date", "author", "url"):
                val = record.get(key)
                if val and str(val).strip():
                    self.fact(entity_id, key, source_id, value=clean_text(val, 900))
