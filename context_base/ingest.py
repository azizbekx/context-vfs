from __future__ import annotations

import csv
import json
import logging
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
    ):
        self.store = store
        self.dataset_dir = dataset_dir
        self.run_id = run_id
        self.force = force
        self.use_llm = use_llm
        self.stats = BuildStats()
        self._pending_policy_knowledge: dict[str, dict[str, Any]] = {}

    def build(self) -> BuildStats:
        extractors: list[Callable[[], None]] = [
            self.extract_employees,
            self.extract_resumes,
            self.extract_customers,
            self.extract_products,
            self.extract_sales,
            self.extract_product_sentiment,
            self.extract_support_chats,
            self.extract_tickets,
            self.extract_business_clients,
            self.extract_business_vendors,
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
        self.store.mark_missing_sources_stale(self.run_id)
        self.detect_conflicts()
        self.store.commit()
        return self.stats

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

    def extract_customers(self) -> None:
        relative = "Customer_Relation_Management/customers.json"
        for record in self.json_records(relative):
            customer_id = clean_text(record.get("customer_id"))
            if not customer_id:
                continue
            source_id, changed = self.source(relative, customer_id, "customer", record)
            entity_id = f"customer:{customer_id}"
            self.entity(
                entity_id,
                "customer",
                record.get("customer_name") or customer_id,
                f"company/customers/{customer_id}.md",
                aliases=[customer_id],
            )
            if not changed:
                continue
            self.fact(entity_id, "name", source_id, value=record.get("customer_name"))
            for predicate in ("invoice_paths", "purchase_order_paths", "shipping_order_paths"):
                self.fact(entity_id, predicate, source_id, value=record.get(predicate))

    def extract_products(self) -> None:
        relative = "Customer_Relation_Management/products.json"
        for record in self.json_records(relative):
            product_id = clean_text(record.get("product_id"))
            if not product_id:
                continue
            source_id, changed = self.source(relative, product_id, "product", record)
            entity_id = f"product:{product_id}"
            self.entity(
                entity_id,
                "product",
                record.get("product_name") or product_id,
                f"company/products/{slugify(product_id)}.md",
                aliases=[product_id, record.get("category", "")],
                summary=clean_text(record.get("about_product"), 420),
            )
            if not changed:
                continue
            for predicate in (
                "product_name",
                "category",
                "discounted_price",
                "actual_price",
                "rating",
                "about_product",
            ):
                self.fact(entity_id, predicate, source_id, value=record.get(predicate))

    def extract_sales(self) -> None:
        relative = "Customer_Relation_Management/sales.json"
        for record in self.json_records(relative):
            sale_id = clean_text(record.get("sales_record_id"))
            customer_id = clean_text(record.get("customer_id"))
            product_id = clean_text(record.get("product_id"))
            if not sale_id or not customer_id or not product_id:
                continue
            source_id, changed = self.source(relative, sale_id, "sale", record)
            if not changed:
                continue
            sale_entity = self.entity(
                f"sale:{sale_id}",
                "sale",
                f"Sale {sale_id}",
                None,
                aliases=[sale_id],
            )
            customer_entity = f"customer:{customer_id}"
            product_entity = f"product:{product_id}"
            self.entity(customer_entity, "customer", customer_id, f"company/customers/{customer_id}.md", aliases=[customer_id], confidence=0.7)
            self.entity(product_entity, "product", product_id, f"company/products/{slugify(product_id)}.md", aliases=[product_id], confidence=0.7)
            self.fact(sale_entity, "customer", source_id, object_entity_id=customer_entity)
            self.fact(sale_entity, "product", source_id, object_entity_id=product_entity)
            self.fact(sale_entity, "date_of_purchase", source_id, value=record.get("Date_of_Purchase"))
            self.fact(sale_entity, "discounted_price", source_id, value=record.get("discounted_price"))
            self.fact(sale_entity, "actual_price", source_id, value=record.get("actual_price"))
            self.fact(customer_entity, "purchased_product", source_id, object_entity_id=product_entity)

    def extract_product_sentiment(self) -> None:
        relative = "Customer_Relation_Management/Product Sentiment/product_sentiment.json"
        for record in self.json_records(relative):
            sentiment_id = clean_text(record.get("sentiment_id"))
            customer_id = clean_text(record.get("customer_id"))
            product_id = clean_text(record.get("product_id"))
            if not sentiment_id or not customer_id or not product_id:
                continue
            source_id, changed = self.source(relative, sentiment_id, "product_sentiment", record)
            if not changed:
                continue
            sentiment_entity = self.entity(
                f"sentiment:{sentiment_id}",
                "sentiment",
                f"Product sentiment {sentiment_id}",
                None,
            )
            customer_entity = f"customer:{customer_id}"
            product_entity = f"product:{product_id}"
            self.fact(sentiment_entity, "customer", source_id, object_entity_id=customer_entity)
            self.fact(sentiment_entity, "product", source_id, object_entity_id=product_entity)
            self.fact(sentiment_entity, "review_date", source_id, value=record.get("review_date"))
            self.fact(sentiment_entity, "review_content", source_id, value=clean_text(record.get("review_content"), 900))

    def extract_support_chats(self) -> None:
        relative = "Customer_Relation_Management/Customer Support/customer_support_chats.json"
        for record in self.json_records(relative):
            chat_id = clean_text(record.get("chat_id"))
            if not chat_id:
                continue
            source_id, changed = self.source(relative, chat_id, "support_chat", record)
            chat_entity = self.entity(
                f"support_chat:{chat_id}",
                "support_chat",
                f"Support chat {chat_id}",
                None,
                summary=clean_text(record.get("text"), 420),
            )
            if not changed:
                continue
            customer_id = clean_text(record.get("customer_id"))
            product_id = clean_text(record.get("product_id"))
            emp_id = clean_text(record.get("emp_id"))
            if customer_id:
                self.fact(chat_entity, "customer", source_id, object_entity_id=f"customer:{customer_id}")
            if product_id:
                self.fact(chat_entity, "product", source_id, object_entity_id=f"product:{product_id}")
            if emp_id:
                self.fact(chat_entity, "handled_by", source_id, object_entity_id=f"employee:{emp_id}")
            self.fact(chat_entity, "interaction_date", source_id, value=record.get("interaction_date"))
            self.fact(chat_entity, "text", source_id, value=clean_text(record.get("text"), 900))

    def extract_tickets(self) -> None:
        relative = "IT_Service_Management/it_tickets.json"
        for record in self.json_records(relative):
            ticket_id = clean_text(record.get("id"))
            if not ticket_id:
                continue
            source_id, changed = self.source(relative, ticket_id, "it_ticket", record)
            entity_id = f"ticket:{ticket_id}"
            self.entity(
                entity_id,
                "ticket",
                f"IT ticket {ticket_id}",
                f"company/tickets/{ticket_id}.md",
                aliases=[ticket_id, record.get("priority", "")],
                summary=clean_text(record.get("Issue"), 420),
            )
            if not changed:
                continue
            self.fact(entity_id, "priority", source_id, value=record.get("priority"))
            self.fact(entity_id, "assigned_date", source_id, value=record.get("assigned_date"))
            self.fact(entity_id, "issue", source_id, value=clean_text(record.get("Issue"), 1200))
            self.fact(entity_id, "resolution", source_id, value=clean_text(record.get("Resolution"), 1200))
            raised_by = clean_text(record.get("raised_by_emp_id"))
            assigned_to = clean_text(record.get("emp_id"))
            if raised_by:
                self.fact(entity_id, "raised_by", source_id, object_entity_id=f"employee:{raised_by}")
            if assigned_to:
                self.fact(entity_id, "assigned_to", source_id, object_entity_id=f"employee:{assigned_to}")

    def extract_business_clients(self) -> None:
        relative = "Business_and_Management/clients.json"
        for record in self.json_records(relative):
            client_id = clean_text(record.get("client_id"))
            if not client_id:
                continue
            source_id, changed = self.source(relative, client_id, "business_client", record)
            entity_id = f"client:{client_id}"
            self.entity(
                entity_id,
                "client",
                record.get("business_name") or client_id,
                f"company/clients/{client_id}.md",
                aliases=[client_id, record.get("contact_email", "")],
                summary=clean_text(record.get("engagement_description"), 420),
            )
            if not changed:
                continue
            for predicate in (
                "industry",
                "business_type",
                "contact_person_name",
                "contact_email",
                "monthly_revenue",
                "onboarding_date",
                "current_poc_product",
                "poc_status",
                "engagement_description",
            ):
                key = predicate if predicate in record else predicate.replace("current_poc", "current_POC").replace("poc_status", "POC_status")
                self.fact(entity_id, predicate, source_id, value=record.get(key))
            rep = clean_text(record.get("business_representative_employee"))
            if rep:
                self.fact(entity_id, "business_representative", source_id, object_entity_id=f"employee:{rep}")

    def extract_business_vendors(self) -> None:
        relative = "Business_and_Management/vendors.json"
        for record in self.json_records(relative):
            vendor_id = clean_text(record.get("client_id"))
            if not vendor_id:
                continue
            source_id, changed = self.source(relative, vendor_id, "vendor", record)
            entity_id = f"vendor:{vendor_id}"
            self.entity(
                entity_id,
                "vendor",
                record.get("business_name") or vendor_id,
                f"company/vendors/{vendor_id}.md",
                aliases=[vendor_id],
                summary=clean_text(record.get("relationship_description"), 420),
            )
            if not changed:
                continue
            for predicate in (
                "industry",
                "business_type",
                "registered_address",
                "tax_id",
                "onboarding_date",
                "relationship_description",
            ):
                self.fact(entity_id, predicate, source_id, value=record.get(predicate))
            rep = clean_text(record.get("management_representative_employee"))
            if rep:
                self.fact(entity_id, "management_representative", source_id, object_entity_id=f"employee:{rep}")

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
                None,
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
                None,
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
                None,
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
            None,
            summary=body,
            confidence=0.62,
        )
        self.fact(source_entity_id, "mentions_work_item", source_id, object_entity_id=work_id, confidence=0.62)
        self.fact(work_id, "evidence", source_id, value=body, confidence=0.62, extraction_method="heuristic")

    def detect_conflicts(self) -> None:
        rows = self.store.rows(
            """
            SELECT subject_id, predicate, COUNT(DISTINCT value) AS value_count
            FROM facts
            WHERE status = 'generated'
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
                SELECT f.id, f.value, f.confidence, s.dataset_path, s.record_id
                FROM facts f
                JOIN source_records s ON s.id = f.source_id
                WHERE f.subject_id = ? AND f.predicate = ? AND f.status = 'generated'
                ORDER BY f.confidence DESC, s.dataset_path
                """,
                (row["subject_id"], row["predicate"]),
            )
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
