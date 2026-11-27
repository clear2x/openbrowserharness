/**
 * Path grammar of the bilingual corpus. The English document `D/foo.md`,
 * its Chinese counterpart `D/zh/foo.md`, and the consistency record
 * `D/zh/foo.i18n.yaml` form one pair; the frozen `.agents/notes/archived/`
 * tree keeps its retired `.zh.md` naming and is outside this grammar.
 */

/** Whether a repository-relative path lives on the Chinese side of a pair (`zh/` corpus segment). */
export function isZhCorpusPath(file: string): boolean {
  return /(^|\/)zh\//.test(file)
}

/**
 * English corpus path of a Chinese-side path: drop the first `zh/` segment
 * (`docs/guide/zh/index.md` → `docs/guide/index.md`). Identity off the Chinese side.
 */
export function englishCorpusPath(file: string): string {
  return file.replace(/(^|\/)zh\//, '$1')
}

/** Chinese-side corpus path of an English document: insert the `zh/` segment before the basename. */
export function zhCorpusPath(source: string): string {
  if (isZhCorpusPath(source)) throw new Error(`expected an English corpus path, received ${JSON.stringify(source)}`)
  return source.replace(/^(.*\/)?([^/]+)$/, '$1zh/$2')
}
