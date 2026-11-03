const FILE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export function languageFromPath(path: string | null): string | null {
  if (path === null) return null;
  const basename = path.toLowerCase().split(/[\\/]/).at(-1) ?? path.toLowerCase();
  if (basename === "dockerfile") return "dockerfile";
  const extension = basename.slice(basename.lastIndexOf(".") + 1);
  if (
    !extension ||
    extension === basename ||
    !Object.hasOwn(FILE_LANGUAGE_BY_EXTENSION, extension)
  ) {
    return null;
  }
  return FILE_LANGUAGE_BY_EXTENSION[extension] ?? null;
}
