// Query analysis helpers (pure).

const STOP = new Set(
  ("a an the and or but if of to in on at by for with from as is are was were be been being do does did done this that these those it its " +
   "i me my we our us you your he she they them his her their what which who whom whose when where why how whats " +
   "about into over under than then there here also just only very can could should would will shall may might must " +
   "all any each every some more most other such no not nor so too again further once both either neither own same " +
   "please tell show give explain describe define find list recall summarize summarise everything anything something thing things " +
   "learn learned learnt study studied studying taught teach teaching cover covered say said mention mentioned discuss discussed talk talked " +
   "lecture lectures lec slide slides class course notes note sir madam miss teacher lecturer professor prof instructor " +
   "between difference differences compare comparison vs versus related relate relates relation relationship connect connection connections " +
   "first introduced introduce appear appears appeared where whole entire semester exam revise revision important example examples " +
   "develop developed development throughout across kind kinds type types way ways get got make made let us use using " +
   "happen happens happened currently actually basically exactly really mean means meant").split(/\s+/),
);

// Words that carry meaning for retrieval even though they're common ("used", "memory" etc. are NOT stop words).
export function tokens(s: string): string[] {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9][a-z0-9'-]*/g)?.map((t) => t.replace(/'s$|'/g, "")) ?? [];
}

/** Content terms: tokens minus question/navigation words. Used for coverage scoring and the not-found gate. */
export function contentTerms(s: string): string[] {
  return [...new Set(tokens(s).filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t)))];
}

export const isStopword = (t: string) => STOP.has(t);

/** Lowercase, strip punctuation, singularise simply — used to normalise concept names. */
export function normConcept(s: string): string {
  return tokens(s)
    .map((w) => (w.length > 5 && w.endsWith("ies") ? w.slice(0, -3) + "y"
      : w.length > 5 && /(sses|xes|ches|shes)$/.test(w) ? w.slice(0, -2)
      : w.length > 4 && /[^s]s$/.test(w) && !/(ss|us|is|ys)$/.test(w) ? w.slice(0, -1) : w))
    .join(" ")
    .trim();
}
