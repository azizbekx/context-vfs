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
            [],
        )
        self._write_json(
            "Customer_Relation_Management/Customer Support/customer_support_chats.json",
            [],
        )
        self._write_json("Business_and_Management/clients.json", [])
        self._write_json("Business_and_Management/vendors.json", [])
        self._write_json("Enterprise_Mail_System/emails.json", [])
        self._write_json("Collaboration_tools/conversations.json", [])
        self._write_json("Enterprise_Social_Platform/posts.json", [])
        self._write_json("Workspace/GitHub/GitHub.json", [])
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
        finally:
            store.close()

    def test_search_finds_ticket_context(self) -> None:
        store = self._build()
        try:
            results = search(store, self.out, "VPN engineering", limit=5)
            paths = {item.get("path") for item in results}
            self.assertIn("company/tickets/T1.md", paths)
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


if __name__ == "__main__":
    unittest.main()
