// The ONLY definition of the data/prayers.json schema.
// Everything else (types, JSON Schema, validation) derives from this file.
import { z } from "zod";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const THEMES = [
  "s-emerald",
  "s-blue",
  "s-rose",
  "s-cyan",
  "s-violet",
  "s-amber",
  "s-magenta",
  "s-indigo",
] as const;

const isoDate = z.iso.datetime({ offset: true });

/** Bilingual string. `te` may be "" only when the owning request has te_status "needs_review". */
export const BiSchema = z
  .strictObject({
    en: z.string().min(1, "en must not be empty"),
    te: z.string(),
  })
  .describe("Bilingual text: English + Telugu");

export const TeStatusSchema = z.enum(["human", "auto", "needs_review"]);
export const RequestStatusSchema = z.enum(["active", "answered", "archived"]);
export const SourceSchema = z.enum(["manual", "mcp", "site"]);
export const LayoutSchema = z.enum(["list", "three-col"]);

export const AnswerSchema = z.strictObject({
  text: BiSchema,
  answered_at: isoDate,
});

const LIST_ONLY_WITH_NAME = ["note", "label", "detail", "items"] as const;

export const RequestSchema = z
  .strictObject({
    id: z.string().regex(SLUG, "id must be a lowercase slug (a-z, 0-9, '-')"),
    status: RequestStatusSchema,
    visibility: z.literal("public").default("public"),
    source: SourceSchema,
    created_at: isoDate,
    te_status: TeStatusSchema,

    // list layout
    plain: z.boolean().optional(),
    text: BiSchema.optional(),
    name: BiSchema.optional(),
    note: BiSchema.optional(),
    label: BiSchema.optional(),
    detail: BiSchema.optional(),
    items: z.array(BiSchema).optional(),

    // three-col layout
    children: z.array(BiSchema).optional(),

    answer: AnswerSchema.optional(),
  })
  .superRefine((r, ctx) => {
    const hasText = r.text !== undefined;
    const hasName = r.name !== undefined;
    if (hasText === hasName) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of `text` or `name` must be present",
        path: hasText ? ["name"] : ["text"],
      });
    }
    if (r.plain && !hasText) {
      ctx.addIssue({ code: "custom", message: "plain rows must use `text`", path: ["plain"] });
    }
    if (hasText) {
      for (const k of [...LIST_ONLY_WITH_NAME, "children"] as const) {
        if (r[k] !== undefined) {
          ctx.addIssue({ code: "custom", message: `\`${k}\` is only allowed with \`name\`, not \`text\``, path: [k] });
        }
      }
    }
    // Empty Telugu is only allowed while awaiting review.
    if (r.te_status !== "needs_review") {
      const check = (bi: { te: string } | undefined, path: (string | number)[]) => {
        if (bi && bi.te.trim() === "") {
          ctx.addIssue({
            code: "custom",
            message: `te must not be empty unless te_status is "needs_review" (te_status is "${r.te_status}")`,
            path: [...path, "te"],
          });
        }
      };
      check(r.text, ["text"]);
      check(r.name, ["name"]);
      check(r.note, ["note"]);
      check(r.label, ["label"]);
      check(r.detail, ["detail"]);
      r.items?.forEach((b, i) => check(b, ["items", i]));
      r.children?.forEach((b, i) => check(b, ["children", i]));
      check(r.answer?.text, ["answer", "text"]);
    }
  });

export const ColumnsSchema = z.strictObject({
  parents: BiSchema,
  children: BiSchema,
  prayer: BiSchema,
});

export const SlideSchema = z
  .strictObject({
    id: z.string().regex(SLUG, "slide id must be a lowercase slug"),
    num: z.number().int().nonnegative(),
    title: BiSchema,
    theme: z.enum(THEMES),
    glow: z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "glow must be a hex colour like #818cf8"),
    layout: LayoutSchema,
    timer_seconds: z.number().int().positive().default(300),
    columns: ColumnsSchema.optional(),
    add_panel: z.boolean().optional(),
    requests: z.array(RequestSchema),
  })
  .superRefine((s, ctx) => {
    if (s.layout === "three-col") {
      if (!s.columns) {
        ctx.addIssue({ code: "custom", message: "three-col slides require `columns`", path: ["columns"] });
      }
      s.requests.forEach((r, i) => {
        if (!r.name) ctx.addIssue({ code: "custom", message: "three-col requests require `name`", path: ["requests", i, "name"] });
        if (!r.children || r.children.length === 0)
          ctx.addIssue({ code: "custom", message: "three-col requests require non-empty `children`", path: ["requests", i, "children"] });
        if (!r.items || r.items.length === 0)
          ctx.addIssue({ code: "custom", message: "three-col requests require non-empty `items`", path: ["requests", i, "items"] });
        for (const k of ["note", "label", "detail", "plain"] as const) {
          if (r[k] !== undefined)
            ctx.addIssue({ code: "custom", message: `\`${k}\` is not used on three-col slides`, path: ["requests", i, k] });
        }
      });
    } else {
      if (s.columns) ctx.addIssue({ code: "custom", message: "`columns` is only for three-col slides", path: ["columns"] });
      s.requests.forEach((r, i) => {
        if (r.children !== undefined)
          ctx.addIssue({ code: "custom", message: "`children` is only for three-col slides", path: ["requests", i, "children"] });
      });
    }
  });

export const RootSchema = z
  .strictObject({
    version: z.literal(1),
    updated_at: isoDate,
    slides: z.array(SlideSchema),
  })
  .superRefine((root, ctx) => {
    const slideIds = new Map<string, number>();
    const slideNums = new Map<number, number>();
    const reqIds = new Map<string, string>();
    let addPanels = 0;
    root.slides.forEach((s, si) => {
      if (slideIds.has(s.id))
        ctx.addIssue({ code: "custom", message: `duplicate slide id "${s.id}" (also slides[${slideIds.get(s.id)}])`, path: ["slides", si, "id"] });
      else slideIds.set(s.id, si);
      if (slideNums.has(s.num))
        ctx.addIssue({ code: "custom", message: `duplicate slide num ${s.num} (also slides[${slideNums.get(s.num)}])`, path: ["slides", si, "num"] });
      else slideNums.set(s.num, si);
      if (s.add_panel) addPanels++;
      s.requests.forEach((r, ri) => {
        const prev = reqIds.get(r.id);
        if (prev !== undefined)
          ctx.addIssue({ code: "custom", message: `duplicate request id "${r.id}" (also ${prev})`, path: ["slides", si, "requests", ri, "id"] });
        else reqIds.set(r.id, `slides[${si}](${s.id}).requests[${ri}]`);
      });
    });
    if (addPanels > 1)
      ctx.addIssue({ code: "custom", message: "at most one slide may have add_panel: true", path: ["slides"] });
  });

export type Bi = z.infer<typeof BiSchema>;
export type TeStatus = z.infer<typeof TeStatusSchema>;
export type RequestStatus = z.infer<typeof RequestStatusSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Layout = z.infer<typeof LayoutSchema>;
export type Answer = z.infer<typeof AnswerSchema>;
export type PrayerRequest = z.infer<typeof RequestSchema>;
export type Columns = z.infer<typeof ColumnsSchema>;
export type Slide = z.infer<typeof SlideSchema>;
export type Root = z.infer<typeof RootSchema>;

export class ValidationError extends Error {
  constructor(message: string, public readonly issues: z.core.$ZodIssue[]) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Parse and validate a prayers.json document. Throws ValidationError with a readable message. */
export function validateRoot(data: unknown): Root {
  const res = RootSchema.safeParse(data);
  if (!res.success) {
    throw new ValidationError(`prayers.json is invalid:\n${z.prettifyError(res.error)}`, res.error.issues);
  }
  return res.data;
}
