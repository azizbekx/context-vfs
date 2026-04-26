from __future__ import annotations

import csv
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from context_base.ingest import ContextBuilder
from context_base.search import search
from context_base.storage import Store
from context_base.utils import now_iso, stable_hash, stable_id
from context_base.vfs import VFSGenerator


class ContextBaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dataset = self.root / "dataset"
        self.out = self.root / "out"
        self._write_fixture_dataset()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write_json(self, relative: str, payload: object) -> None:
        path = self.dataset / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")

    def _write_fixture_dataset(self) -> None:
        self._write_json(
            "Human_Resource_Management/Employees/employees.json",
            [
                {
                    "emp_id": "emp_1",
                    "Name": "Alice Example",
                    "category": "Engineering",
                    "description": "Engineering manager for platform systems.",
                    "Experience": "Builds internal platforms.",
                    "Level": "EN10",
                    "email": "alice@example.com",
                    "DOJ": "2020-01-01",
                    "DOL": "Present",
                    "Salary": "100",
                    "Performance Rating": "5",
                    "skills": "Python, Systems",
                    "Remaining Casual Leaves": "1",
                    "Remaining Sick Leaves": "2",
                    "Remaining Vacation Leaves": "3",
                    "Total Leaves Taken": "4",
                    "is_valid": "TRUE",
                    "reports_to": None,
                    "reportees": ["emp_2"],
                },
                {
                    "emp_id": "emp_2",
                    "Name": "Bob Example",
                    "category": "IT",
                    "description": "IT support specialist.",
                    "Experience": "Handles VPN support.",
                    "Level": "IT5",
                    "email": "bob@example.com",
                    "DOJ": "2021-01-01",
                    "DOL": "Present",
                    "Salary": "90",
                    "Performance Rating": "4",
                    "skills": "VPN, Email",
                    "Remaining Casual Leaves": "2",
                    "Remaining Sick Leaves": "2",
                    "Remaining Vacation Leaves": "2",
                    "Total Leaves Taken": "6",
                    "is_valid": "TRUE",
                    "reports_to": "emp_1",
                    "reportees": [],
                },
            ],
        )
        self._write_json(
            "IT_Service_Management/it_tickets.json",
            [
                {
                    "id": "T1",
                    "priority": "high",
                    "raised_by_emp_id": "emp_1",
                    "assigned_date": "2024-01-10",
                    "emp_id": "emp_2",
                    "Issue": "VPN access issue blocks engineering work.",
                    "Resolution": "Reset VPN profile.",
                }
            ],
        )
        self._write_json(
            "Customer_Relation_Management/customers.json",
            [
                {
                    "customer_id": "cust1",
                    "customer_name": "Acme Corp",
                    "invoice_paths": "invoice.pdf",
                    "purchase_order_paths": "po.pdf",
                    "shipping_order_paths": "ship.pdf",
                }
            ],
        )
        self._write_json(
            "Customer_Relation_Management/products.json",
            [
                {
                    "product_id": "prod1",
                    "product_name": "Context Widget",
                    "category": "Tools",
                    "discounted_price": "$9",
                    "actual_price": "$10",
                    "rating": "4.8",
                    "about_product": "A tool for context workflows.",
                }
            ],
        )
        self._write_json(
            "Customer_Relation_Management/sales.json",
            [
                {
                    "sales_record_id": "sale1",
                    "customer_id": "cust1",
                    "product_id": "prod1",
                    "discounted_price": "$9",
                    "actual_price": "$10",
                    "Date_of_Purchase": "2024-02-01",
                }
            ],
        )
        self._write_json(
            "Customer_Relation_Management/Product Sentiment/product_sentiment.json",
            [
                {
                    "sentiment_id": "sent1",
                    "customer_id": "cust1",
                    "product_id": "prod1",
                    "review_date": "2024-02-03",
                    "review_content": "Useful for context work.",
                }
            ],
        )
        self._write_json(
            "Customer_Relation_Management/Customer Support/customer_support_chats.json",
            [
                {
                    "chat_id": "chat1",
                    "customer_id": "cust1",
                    "product_id": "prod1",
                    "emp_id": "emp_2",
                    "interaction_date": "2024-02-04",
                    "text": "Customer asked about rollout status.",
                }
            ],
        )
        self._write_json("Business_and_Management/clients.json", [])
        self._write_json("Business_and_Management/vendors.json", [])
        self._write_json(
            "Enterprise_Mail_System/emails.json",
            [
                {
                    "email_id": "email1",
                    "thread_id": "thread1",
                    "sender_emp_id": "emp_1",
                    "recipient_emp_id": "emp_2",
                    "date": "2024-02-05",
                    "subject": "Project launch status",
                    "category": "project",
                    "importance": "high",
                    "body": "Project launch status is blocked by VPN setup.",
                }
            ],
        )
        self._write_json(
            "Collaboration_tools/conversations.json",
            [
                {
                    "conversation_id": "conv1",
                    "sender_emp_id": "emp_1",
                    "recipient_emp_id": "emp_2",
                    "date": "2024-02-06",
                    "text": "Task deadline depends on VPN access.",
                }
            ],
        )
        self._write_json(
            "Enterprise_Social_Platform/posts.json",
            [
                {
                    "emp_id": "emp_1",
                    "Title": "Launch milestone",
                    "Post": "The project launch milestone is on track.",
                }
            ],
        )
        self._write_json("Workspace/GitHub/GitHub.json", [])
        self._write_json("Inazuma_overflow/overflow.json", [
            {
                "id": "ov1",
                "type": "knowledge",
                "title": "VPN Setup Guide",
                "content": "How to set up VPN for remote workers.",
                "category": "IT",
                "status": "published",
            },
        ])
        resume_path = self.dataset / "Human_Resource_Management/Resume/resume_information.csv"
        resume_path.parent.mkdir(parents=True, exist_ok=True)
        with resume_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=[
                    "resume_id",
                    "emp_id",
                    "category",
                    "name",
                    "content",
                    "email",
                    "created_date",
                    "file_path",
                ],
            )
            writer.writeheader()

    def _build(self, *, force: bool = True) -> Store:
        store = Store(self.out / "context.db")
        store.init_schema()
        if force:
            store.reset()
        builder = ContextBuilder(store, self.dataset, now_iso(), force=force)
        builder.build()
        VFSGenerator(store, self.out).generate()
        return store

    def test_stable_ids_and_hashes_are_deterministic(self) -> None:
        self.assertEqual(stable_hash({"b": 2, "a": 1}), stable_hash({"a": 1, "b": 2}))
        self.assertEqual(stable_id("x", "a", 1), stable_id("x", "a", 1))

    def test_build_populates_entities_facts_edges_and_vfs(self) -> None:
        store = self._build()
        try:
            employee = store.row("SELECT * FROM entities WHERE id = ?", ("employee:emp_1",))
            self.assertIsNotNone(employee)
            self.assertEqual(employee["name"], "Alice Example")
            fact_count = store.row("SELECT COUNT(*) AS count FROM facts")["count"]
            edge_count = store.row("SELECT COUNT(*) AS count FROM edges")["count"]
            self.assertGreater(fact_count, 10)
            self.assertGreater(edge_count, 2)
            employee_file = self.out / "vfs/company/employees/emp_1.md"
            self.assertTrue(employee_file.exists())
            text = employee_file.read_text(encoding="utf-8")
            self.assertIn("## Provenance", text)
            self.assertIn("Human_Resource_Management/Employees/employees.json#emp_1", text)
            self.assertIn("Fact ID", text)
            coverage_file = self.out / "vfs/company/source-coverage.md"
            self.assertTrue(coverage_file.exists())
            coverage_text = coverage_file.read_text(encoding="utf-8")
            self.assertIn("## Sources", coverage_text)
            self.assertIn("Human_Resource_Management/Employees/employees.json", coverage_text)
            index_file = self.out / "vfs/company/index.md"
            self.assertTrue(index_file.exists())
            index_text = index_file.read_text(encoding="utf-8")
            self.assertIn("# Company Context Base", index_text)
            self.assertIn("Employees", index_text)
            emp_index = self.out / "vfs/company/employees/_index.md"
            self.assertTrue(emp_index.exists())
            for relative in (
                "company/sales/sale1.md",
                "company/sentiment/sent1.md",
                "company/support-chats/chat1.md",
                "company/email-threads/thread1.md",
                "company/conversations/conv1.md",
            ):
                self.assertTrue((self.out / "vfs" / relative).exists(), relative)
            self.assertEqual(len(list((self.out / "vfs/company/posts").glob("*.md"))), 2)
            self.assertTrue((self.out / "vfs/company/projects/_index.md").exists())
            self.assertTrue((self.out / "vfs/company/tasks/_index.md").exists())
        finally:
            store.close()

    def test_search_finds_ticket_context(self) -> None:
        store = self._build()
        try:
            results = search(store, self.out, "VPN engineering", limit=5)
            paths = {item.get("path") for item in results}
            self.assertIn("company/tickets/t1.md", paths)
            fts_results = search(store, self.out, "blocked project", limit=5)
            self.assertTrue(any(item.get("kind") in {"entity", "fact", "file"} for item in fts_results))
        finally:
            store.close()

    def test_incremental_build_skips_unchanged_sources(self) -> None:
        store = self._build(force=True)
        store.close()

        store = Store(self.out / "context.db")
        store.init_schema()
        try:
            stats = ContextBuilder(store, self.dataset, now_iso(), force=False).build()
            self.assertGreater(stats.sources_seen, 0)
            self.assertEqual(stats.sources_changed, 0)
        finally:
            store.close()

    def test_incremental_build_removes_entities_and_vfs_for_deleted_sources(self) -> None:
        store = self._build(force=True)
        store.close()
        ticket_file = self.out / "vfs/company/tickets/t1.md"
        self.assertTrue(ticket_file.exists())

        self._write_json("IT_Service_Management/it_tickets.json", [])

        store = Store(self.out / "context.db")
        store.init_schema()
        try:
            ContextBuilder(store, self.dataset, "delete-run", force=False).build()
            VFSGenerator(store, self.out).generate()
            self.assertIsNone(store.row("SELECT * FROM entities WHERE id = 'ticket:T1'"))
            self.assertIsNone(
                store.row("SELECT * FROM vfs_files WHERE path = 'company/tickets/t1.md'")
            )
            self.assertFalse(ticket_file.exists())
        finally:
            store.close()

    def test_manual_fact_survives_rebuild(self) -> None:
        store = self._build(force=True)
        fact_id = store.upsert_fact(
            subject_id="employee:emp_1",
            predicate="human_note",
            source_id="source:manual",
            run_id="manual",
            value="Confirmed by the platform team.",
            status="confirmed",
            extraction_method="manual",
        )
        store.commit()
        store.close()

        store = Store(self.out / "context.db")
        store.init_schema()
        try:
            ContextBuilder(store, self.dataset, "next-run", force=False).build()
            fact = store.row("SELECT * FROM facts WHERE id = ?", (fact_id,))
            self.assertIsNotNone(fact)
            self.assertEqual(fact["status"], "confirmed")
            manual_source = store.row("SELECT stale FROM source_records WHERE id = 'source:manual'")
            self.assertEqual(manual_source["stale"], 0)
        finally:
            store.close()

    def test_conflict_detection_creates_review_item(self) -> None:
        store = Store(self.out / "context.db")
        store.init_schema()
        store.reset()
        source_a = store.upsert_source(
            dataset_path="a.json",
            record_id="1",
            kind="test",
            payload={"department": "Engineering"},
            raw_ref="a.json#1",
            run_id="run",
            force=True,
        )
        source_b = store.upsert_source(
            dataset_path="b.json",
            record_id="2",
            kind="test",
            payload={"department": "Sales"},
            raw_ref="b.json#2",
            run_id="run",
            force=True,
        )
        store.upsert_entity(
            entity_id="employee:conflict",
            entity_type="employee",
            name="Conflict Person",
            path="company/employees/conflict.md",
        )
        store.upsert_fact(
            subject_id="employee:conflict",
            predicate="department",
            source_id=source_a.id,
            run_id="run",
            value="Engineering",
        )
        store.upsert_fact(
            subject_id="employee:conflict",
            predicate="department",
            source_id=source_b.id,
            run_id="run",
            value="Sales",
        )
        builder = ContextBuilder(store, self.dataset, "run", force=False)
        builder.detect_conflicts()
        review_count = store.row("SELECT COUNT(*) AS count FROM review_items")["count"]
        self.assertEqual(review_count, 1)
        store.close()

    def test_conflict_detection_includes_confirmed_current_facts(self) -> None:
        store = Store(self.out / "context.db")
        store.init_schema()
        store.reset()
        source_a = store.upsert_source(
            dataset_path="a.json",
            record_id="1",
            kind="test",
            payload={"priority": "high"},
            raw_ref="a.json#1",
            run_id="run",
            force=True,
        )
        source_b = store.upsert_source(
            dataset_path="b.json",
            record_id="2",
            kind="test",
            payload={"priority": "low"},
            raw_ref="b.json#2",
            run_id="run",
            force=True,
        )
        store.upsert_entity(
            entity_id="ticket:conflict",
            entity_type="ticket",
            name="Conflict Ticket",
            path="company/tickets/conflict.md",
        )
        confirmed_fact = store.upsert_fact(
            subject_id="ticket:conflict",
            predicate="priority",
            source_id=source_a.id,
            run_id="run",
            value="high",
            status="confirmed",
        )
        generated_fact = store.upsert_fact(
            subject_id="ticket:conflict",
            predicate="priority",
            source_id=source_b.id,
            run_id="run",
            value="low",
        )
        builder = ContextBuilder(store, self.dataset, "run", force=False)
        builder.detect_conflicts()
        review = store.row("SELECT * FROM review_items")
        self.assertIsNotNone(review)
        candidates = json.loads(review["candidates_json"])
        self.assertEqual({item["fact_id"] for item in candidates}, {confirmed_fact, generated_fact})
        store.close()

    def test_source_of_truth_auto_resolves_employee_department(self) -> None:
        store = Store(self.out / "context.db")
        store.init_schema()
        store.reset()
        hr_source = store.upsert_source(
            dataset_path="Human_Resource_Management/Employees/employees.json",
            record_id="emp_1",
            kind="employee",
            payload={"department": "Engineering"},
            raw_ref="hr#emp_1",
            run_id="run",
            force=True,
        )
        other_source = store.upsert_source(
            dataset_path="Enterprise_Mail_System/emails.json",
            record_id="m1",
            kind="email",
            payload={"department": "Sales"},
            raw_ref="mail#m1",
            run_id="run",
            force=True,
        )
        store.upsert_entity(
            entity_id="employee:emp_1",
            entity_type="employee",
            name="Alice Example",
            path="company/employees/emp_1.md",
        )
        hr_fact = store.upsert_fact(
            subject_id="employee:emp_1",
            predicate="department",
            source_id=hr_source.id,
            run_id="run",
            value="Engineering",
            confidence=0.8,
        )
        other_fact = store.upsert_fact(
            subject_id="employee:emp_1",
            predicate="department",
            source_id=other_source.id,
            run_id="run",
            value="Sales",
            confidence=1.0,
        )
        builder = ContextBuilder(store, self.dataset, "run", force=False)
        builder.detect_conflicts()
        review_count = store.row("SELECT COUNT(*) AS count FROM review_items")["count"]
        self.assertEqual(review_count, 0)
        self.assertEqual(
            store.row("SELECT status FROM facts WHERE id = ?", (hr_fact,))["status"],
            "confirmed",
        )
        self.assertEqual(
            store.row("SELECT status FROM facts WHERE id = ?", (other_fact,))["status"],
            "rejected",
        )
        store.close()

    def test_schema_extractor_ingests_generic_source(self) -> None:
        self._write_json(
            "Custom/projects.json",
            [
                {
                    "id": "acme-renewal",
                    "name": "ACME Renewal",
                    "status": "at risk",
                    "owner_emp_id": "emp_1",
                    "summary": "Renewal project for ACME.",
                }
            ],
        )
        schema = {
            "sources": [
                {
                    "path": "Custom/projects.json",
                    "format": "json",
                    "id_field": "id",
                    "entity_type": "project",
                    "name_field": "name",
                    "summary_field": "summary",
                    "path_template": "company/projects/{id}.md",
                    "facts": [
                        {"field": "status", "predicate": "status"},
                        {
                            "field": "owner_emp_id",
                            "predicate": "owner",
                            "entity_ref": {"prefix": "employee", "id_template": "employee:{value}"},
                        },
                    ],
                }
            ]
        }
        store = Store(self.out / "context.db")
        store.init_schema()
        store.reset()
        try:
            builder = ContextBuilder(store, self.dataset, now_iso(), force=True, schema=schema)
            builder.build()
            VFSGenerator(store, self.out).generate()
            project = store.row("SELECT * FROM entities WHERE id = 'project:acme-renewal'")
            self.assertIsNotNone(project)
            self.assertTrue((self.out / "vfs/company/projects/acme-renewal.md").exists())
        finally:
            store.close()

    def test_overflow_data_gets_extracted(self) -> None:
        store = self._build()
        try:
            overflow = store.row("SELECT * FROM entities WHERE type = 'overflow' LIMIT 1")
            self.assertIsNotNone(overflow)
            overflow_file = self.out / "vfs" / overflow["path"]
            self.assertTrue(overflow_file.exists())
            text = overflow_file.read_text(encoding="utf-8")
            self.assertIn("## Provenance", text)
        finally:
            store.close()

    def test_api_mutation_refreshes_vfs(self) -> None:
        try:
            from fastapi.testclient import TestClient
        except ImportError:
            self.skipTest("fastapi test client is not installed")

        from context_base.api import create_app

        store = self._build()
        store.close()
        app = create_app(self.out / "context.db", self.out)
        client = TestClient(app)
        response = client.post(
            "/entities/employee:emp_1/facts",
            json={"predicate": "human_note", "value": "API-confirmed context note."},
        )
        self.assertEqual(response.status_code, 200)
        text = (self.out / "vfs/company/employees/emp_1.md").read_text(encoding="utf-8")
        self.assertIn("API-confirmed context note.", text)

    def test_mcp_tools_support_agent_judgement_workflow(self) -> None:
        store = self._build()
        store.close()

        import mcp_server

        original_out_dir = mcp_server.DEFAULT_OUT_DIR
        mcp_server.set_out_dir(self.out)
        try:
            status = json.loads(mcp_server.get_context_base_status())
            self.assertGreater(status["entities"], 0)
            self.assertGreater(status["facts"], 0)
            self.assertGreater(status["vfs_files"], 0)

            search_payload = json.loads(mcp_server.search_context("VPN engineering"))
            self.assertTrue(
                any(item.get("entity_id") == "ticket:T1" for item in search_payload["results"])
            )

            entity_payload = json.loads(mcp_server.get_entity_context("ticket:T1"))
            fact_ids = {item["predicate"]: item["id"] for item in entity_payload["facts"]}
            self.assertEqual(entity_payload["entity"]["path"], "company/tickets/t1.md")
            self.assertIn("issue", fact_ids)
            self.assertTrue(entity_payload["neighbors"])

            vfs_text = mcp_server.read_vfs_file("company/tickets/t1.md")
            self.assertIn("## Provenance", vfs_text)
            self.assertIn("IT_Service_Management/it_tickets.json#T1", vfs_text)

            source_payload = json.loads(mcp_server.get_fact_source(fact_ids["issue"]))
            self.assertEqual(
                source_payload["fact"]["dataset_path"],
                "IT_Service_Management/it_tickets.json",
            )

            reviews = json.loads(mcp_server.list_review_items(limit=5))
            self.assertEqual(reviews["status"], "open")

            write_payload = json.loads(
                mcp_server.add_entity_fact(
                    "ticket:T1",
                    "judge_note",
                    "Agent verified this ticket has source-backed VPN context.",
                )
            )
            self.assertTrue(write_payload["ok"])
            updated_text = (self.out / "vfs/company/tickets/t1.md").read_text(
                encoding="utf-8"
            )
            self.assertIn("Agent verified this ticket", updated_text)
        finally:
            mcp_server.set_out_dir(original_out_dir)


if __name__ == "__main__":
    unittest.main()
