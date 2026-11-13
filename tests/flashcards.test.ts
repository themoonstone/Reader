import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../lib/store";
import { handle } from "../lib/http";
import { exportBackup } from "../lib/backup";

test("book flashcards are read-only, scoped to active contexts in the chosen chapter and deduplicate by sense", async () => {
  const db = new Store(":memory:");
  try {
    const book = db.createSource({
      id: randomUUID(),
      title: "Flash book",
      type: "Reading",
    });
    const other = db.createSource({
      id: randomUUID(),
      title: "Other book",
      type: "Reading",
    });
    function add(
      term: string,
      meaning: string,
      chapter: string,
      sentence: string,
      priority = "P3",
      sourceId = book.id,
      expressionId?: string,
    ) {
      const draft = db.createDraft(randomUUID(), {
        term,
        meaning,
        chapter,
        sentence,
        priority,
        sourceType: "Reading",
        sourceId,
        targetSurface: sentence.includes("went") ? "went to waste" : "",
      });
      return db.saveDraft(draft.id, {
        version: 1,
        newSense: true,
        expressionId,
      }).expressionId!;
    }
    const id = add("go to waste", "白费", "Chapter 8", "It went to waste.");
    add("go to waste", "白费", "Chapter 8", "", "P3", book.id, id);
    add(
      "go to waste",
      "白费",
      "Chapter 8",
      "The effort went to waste elsewhere.",
      "P3",
      other.id,
      id,
    );
    add("light", "灯", "Chapter 8", "");
    add("light", "轻的", "Chapter 8", "A light box.");
    add("wrong chapter", "另一章", "Chapter 9", "Wrong chapter.");
    add("unmarked", "未标章节", "", "");
    const archived = add("archived", "归档", "Chapter 8", "Archived.");
    const e = db.expression(archived);
    db.updateExpression(archived, e, e.version, "archived");
    const before = exportBackup(db);
    const path = ["sources", book.id, "flashcards"];
    const read = (query = "") =>
      handle(
        new Request(`http://127.0.0.1:3000/api/${path.join("/")}${query}`),
        path,
        db,
      );
    const catalog = await (await read()).json();
    assert.deepEqual(catalog.chapters, ["", "Chapter 8", "Chapter 9"]);
    assert.deepEqual(catalog.cards, []);
    const result = await read("?limit=10&chapter=Chapter+8&priority=P3");
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    const data = await result.json();
    assert.equal(data.cards.length, 3);
    assert.equal(
      data.cards.find((c: { id: string }) => c.id === id).sentence,
      "It went to waste.",
    );
    assert.equal(
      data.cards.find((c: { id: string }) => c.id === id).surface,
      "went to waste",
    );
    assert.deepEqual(
      data.cards
        .filter((c: { term: string }) => c.term === "light")
        .map((c: { meaning: string }) => c.meaning)
        .sort(),
      ["灯", "轻的"],
    );
    assert.equal(
      (await (await read("?limit=5&chapter=&priority=P3")).json()).cards.length,
      1,
    );
    assert.equal(
      (await (await read("?limit=5&chapter=Chapter+8&priority=P1")).json())
        .cards.length,
      0,
    );
    assert.equal((await read("?limit=21")).status, 400);
    assert.equal((await read("?limit=10&priority=invalid")).status, 400);
    const write = await handle(
      new Request(`http://127.0.0.1:3000/api/${path.join("/")}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:3000",
          "X-ReadWords-Generation": db.generation,
        },
        body: "{}",
      }),
      path,
      db,
    );
    assert.equal(write.status, 405);
    assert.deepEqual(
      { ...exportBackup(db), exported_at: before.exported_at },
      before,
    );
  } finally {
    db.close();
  }
});
