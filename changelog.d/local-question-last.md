### Fixed

- The local security check asks its question after the diff, not before it. A server whose context is shorter than
  the prompt drops the start, so with Ollama's default 4096 tokens every diff over about 12 KB lost the question and
  read as NO. The docs now say to raise the server's context to about 16k tokens.
