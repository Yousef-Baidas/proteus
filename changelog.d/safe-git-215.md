### Security

- Hooks no longer let git read a config a sandboxed agent can write (#215). A rewritten `commondir`, a
  worktree's `.git` file, a renamed worktree gitdir or a new `config.worktree` could make the hooks' own git
  calls run `core.fsmonitor` or a clean filter with the human's rights. Every hook git call now goes through
  one wrapper that pins `GIT_DIR` and `GIT_COMMON_DIR` to the project's common dir, skips the system and
  global config (except `verify-tag` and `fetch` on the plugin home), and turns off fsmonitor, hooks and the
  untracked cache. A worktree's HEAD is read as a file, and its changes come from `git diff` and
  `git ls-files -o` on its own index, never `git status`. `git checkout <commit> -- <path>` and
  `git restore --source` are judged by comparing the commit's blobs with the bytes on disk. With
  `core.autocrlf` or a clean filter, a file git would call unchanged may count as changed, so such a call on
  a guarded path can be refused when it would not change anything. The refusal fails closed.
