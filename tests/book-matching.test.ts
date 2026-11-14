import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { selectMatchCandidates } from "../lib/book-matching";
import { exportBackup } from "../lib/backup";
import { handle } from "../lib/http";
import { Store } from "../lib/store";

test("matching candidates exclude homographs and overlapping Chinese glosses", () => {
  const values = [
    ["Step down", "辞职；退出"],
    ["ＳＴＥＰ－ＤＯＷＮ", "向下走"],
    ["back out", "退出，反悔"],
    ["resign", "主动 辞职"],
    ["resignation", "辞 职"],
    ["example", "sample only"],
    ["看", "观察"],
    ["shelter", "避难所"],
    ["stroll", "散步"],
  ].map(([term, meaning], i) => ({ id: String(i), term, meaning }));
  assert.deepEqual(
    selectMatchCandidates(values, 6).map((v) => v.id),
    ["0", "7", "8"],
  );
});

test("matching API scopes both columns, keeps pairs distinct and leaves the library unchanged", async () => {
  const db = new Store(":memory:");
  try {
    const book = db.createSource({
      id: randomUUID(),
      title: "Matching book",
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
      chapter = "Chapter 8",
      priority = "P3",
      sourceId = book.id,
    ) {
      const draft = db.createDraft(randomUUID(), {
        term,
        meaning,
        chapter,
        priority,
        sourceType: "Reading",
        sourceId,
      });
      return db.saveDraft(draft.id, { version: 1, newSense: true })
        .expressionId!;
    }
    const unique = new Map([
      [add("shelter", "避难所"), "避难所"],
      [add("stroll", "散步"), "散步"],
      [add("lentils", "扁豆"), "扁豆"],
      [add("resign", "辞职"), "辞职"],
      [add("take a break", "休息"), "休息"],
    ]);
    add("other chapter", "另一章", "Chapter 9");
    add("other grade", "其他等级", "Chapter 8", "P1");
    add("other book", "另一本书", "Chapter 8", "P3", other.id);
    add("english only", "no Chinese gloss");
    const archived = add("archived", "已归档");
    const expression = db.expression(archived);
    db.updateExpression(archived, expression, expression.version, "archived");
    const before = exportBackup(db);
    const route = ["sources", book.id, "flashcards"];
    const read = (params: string) =>
      handle(
        new Request(`http://127.0.0.1:3000/api/${route.join("/")}?${params}`),
        route,
        db,
      );
    for (const limit of [4, 5, 6]) {
      const res = await read(
        `mode=match&chapter=Chapter+8&priority=P3&limit=${limit}`,
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const { cards, matching } = await res.json();
      assert.deepEqual(cards, []);
      assert.equal(matching.english.length, Math.min(limit, unique.size));
      assert.equal(
        new Set(matching.english.map((option: { id: string }) => option.id))
          .size,
        matching.english.length,
      );
      assert(
        matching.english.every((option: { id: string }) =>
          unique.has(option.id),
        ),
      );
      assert.deepEqual(
        matching.chinese.map((option: { id: string }) => option.id).sort(),
        matching.english.map((option: { id: string }) => option.id).sort(),
      );
      assert(
        matching.chinese.every(
          (option: { id: string; text: string }) =>
            unique.get(option.id) === option.text,
        ),
      );
      assert(
        matching.chinese.some(
          (option: { id: string }, index: number) =>
            option.id !== matching.english[index].id,
        ),
      );
    }
    assert.equal(
      (await (await read("mode=match&chapter=Chapter+9&limit=4")).json())
        .matching,
      undefined,
    );
    assert.equal((await read("mode=match&limit=20")).status, 400);
    assert.equal((await read("mode=match")).status, 400);
    assert.equal((await read("mode=cloze&limit=4")).status, 400);
    assert.deepEqual(
      { ...exportBackup(db), exported_at: before.exported_at },
      before,
    );
  } finally {
    db.close();
  }
});
