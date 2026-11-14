import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../lib/store";
import { handle } from "../lib/http";
import { exportBackup, validateBackup } from "../lib/backup";
import { makeCloze, normalizeClozeAnswer } from "../lib/cloze";
import { choiceForm, clozeDistractors } from "../lib/cloze-choices";

test("backup validation accepts older contexts and preserves optional Chinese context fields", () => {
  const db = new Store(":memory:");
  try {
    const source = db.createSource({
      id: randomUUID(),
      title: "Reading",
      type: "Reading",
    });
    const chinese = {
      sentenceTranslation: "我们先休息。",
      chineseHint: "说话人在提议暂停。",
    };
    for (const [term, extra] of [
      ["take a break", chinese],
      ["rest", {}],
    ] as const) {
      const draft = db.createDraft(randomUUID(), {
        term,
        sourceId: source.id,
        sourceType: "Reading",
        sentence: `Let's ${term}.`,
        meaning: "休息",
        ...extra,
      });
      db.saveDraft(draft.id, { version: 1, newSense: true });
    }
    const backup = validateBackup(exportBackup(db));
    const current = backup.contexts.find(
      (context) => context.data.term === "take a break",
    )!.data;
    assert.equal(current.sentenceTranslation, chinese.sentenceTranslation);
    assert.equal(current.chineseHint, chinese.chineseHint);
    assert.equal(
      backup.contexts.find((context) => context.data.term === "rest")!.data
        .chineseHint,
      undefined,
    );
  } finally {
    db.close();
  }
});

test("choice cloze excludes competing forms, glossary overlap and words already in the prompt", () => {
  const form = (
    term: string,
    meaning: string,
    answer: string,
    before = "The effort had ",
    after = ".",
  ) =>
    choiceForm({
      id: term,
      term,
      meaning,
      chapter: "",
      cloze: { before, after, answer },
    });
  const target = form(
    "go to waste",
    "白费；被浪费",
    "gone to waste",
    "My previous work had ",
    ", even though it had led to change before.",
  )!;
  const variants = [
    form("waste away slowly", "逐渐衰弱", "wasted away slowly"),
    form("go to pot", "白费；毁掉", "gone to pot"),
    form("lead to change", "带来变化", "led to change"),
    form("amount to nothing", "白费；毫无结果", "amounted to nothing"),
    form("wind down", "逐渐结束", "wound down", "The effort "),
    form("break down", "发生故障", "broken down"),
    form("settle in", "安顿下来", "settled in"),
    form("come to a halt", "停止运转", "come to a halt"),
  ].filter((form) => form !== undefined);
  assert.equal(form("be wasted", "消耗掉", "been wasted"), undefined);
  assert.equal(
    form("come to a halt", "停止运转", "come to a halt"),
    undefined,
    "unchanged participles with no reliable form cue are omitted",
  );
  // The two-word phrases are a different shape from this three-word phrase.
  assert.equal(clozeDistractors(target, variants), undefined);
  const others = [
    form("fall into place", "终于就绪", "fallen into place")!,
    form("turn to stone", "化为石头", "turned to stone")!,
  ];
  assert.deepEqual(clozeDistractors(target, [...variants, ...others]), [
    "fallen into place",
    "turned to stone",
  ]);
});

test("original-sentence cloze preserves the actual form and rejects ambiguous or leaking blanks", () => {
  assert.deepEqual(
    makeCloze(
      "I thought it had gone to waste.",
      "go to waste",
      "gone to waste",
    ),
    { before: "I thought it had ", answer: "gone to waste", after: "." },
  );
  assert.deepEqual(makeCloze("A Light box.", "light", ""), {
    before: "A ",
    answer: "Light",
    after: " box.",
  });
  for (const [sentence, term, surface, occurrence] of [
    ["", "light", ""],
    ["Light!", "light", ""],
    ["The freight was lightweight.", "light", "light"],
    ["The freight was light-weight.", "light", "light"],
    ["I can’t go.", "can", ""],
    ["It had gone to waste.", "go to waste", ""],
    ["It had gone to waste.", "go to waste", "Gone to waste"],
    ["He walked and walked.", "walk", "walked", 2],
    ["He walked alone.", "walk", "walked", 2],
    ["Light after light appeared.", "light", ""],
    ["I walk to work. He walked home.", "walk", "walked"],
    [
      "They take a break, then took a break again.",
      "take a break",
      "took a break",
    ],
    [
      "They said it had gone to waste, but GONE  TO WASTE is too strong.",
      "go to waste",
      "gone to waste",
    ],
  ] satisfies [string, string, string, number?][])
    assert.equal(
      makeCloze(sentence, term, surface, occurrence),
      undefined,
      sentence,
    );
  assert.equal(normalizeClozeAnswer("  DON’T   GIVE\nUP  "), "don't give up");
});

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
    add(
      "go to waste",
      "白费",
      "Chapter 8",
      "It would go to waste after it went to waste.",
      "P3",
      book.id,
      id,
    );
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
    assert.match(
      data.cards.find((c: { id: string }) => c.id === id).sentence,
      /^(It went to waste\.|It would go to waste after it went to waste\.)$/,
    );
    assert.equal(
      data.cards.some((c: { cloze?: unknown }) => c.cloze),
      false,
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
    assert.equal((await read("?limit=10&mode=invalid")).status, 400);
    const cloze = await (
      await read("?mode=cloze&limit=5&chapter=Chapter+8&priority=P3")
    ).json();
    assert.equal(cloze.cards.length, 3);
    assert.equal(
      new Set(cloze.cards.map((card: { id: string }) => card.id)).size,
      3,
    );
    assert.deepEqual(
      cloze.cards.find((card: { id: string }) => card.id === id).cloze,
      {
        before: "It ",
        answer: "went to waste",
        after: ".",
      },
    );
    assert.equal(cloze.cards[2].meaning, "灯");
    assert.equal(cloze.cards[2].cloze, undefined);
    const choices = await (
      await read("?mode=cloze-choice&limit=5&chapter=Chapter+8&priority=P3")
    ).json();
    assert.equal(choices.cards.length, 3);
    assert(choices.cards.every((card: { cloze?: unknown }) => !card.cloze));
    assert.equal((await read("?mode=cloze-choice&limit=4")).status, 400);
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
