import { Field } from "./components";

type ChineseContext = { sentenceTranslation?: string; chineseHint?: string };

export default function ChineseContextFields({
  data,
  onChange,
}: {
  data: ChineseContext;
  onChange: (key: keyof ChineseContext, value: string) => void;
}) {
  return (
    <>
      <Field label="原句中文译文（可选）" hint="填写当前原句的整句译文。">
        <textarea
          maxLength={3000}
          value={data.sentenceTranslation ?? ""}
          onChange={(e) => onChange("sentenceTranslation", e.target.value)}
        />
      </Field>
      <Field
        label="中文语境提示（可选）"
        hint="简单交代原句的场景，供选择填空时查看。"
      >
        <textarea
          maxLength={1000}
          value={data.chineseHint ?? ""}
          onChange={(e) => onChange("chineseHint", e.target.value)}
        />
      </Field>
    </>
  );
}
