/** Developer-only tooling (retrieval debug view, reindex controls) is off in production unless NB_DEBUG=1. */
export const debugEnabled = () => process.env.NB_DEBUG === "1" || process.env.NODE_ENV !== "production";
