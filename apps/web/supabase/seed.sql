-- Hallucination Atlas seed. Mirrors packages/core/data/atlas-seed.json: only names documented in
-- published research (source column cites it). Re-runnable.
insert into atlas_names (ecosystem, name, first_seen, models, seen_count, registered, registered_at, source)
values
  ('pypi', 'huggingface-cli', '2023-12-01T00:00:00Z', '{}', 1, true, '2023-12-01T00:00:00Z',
   'Lasso Security (B. Lanyado), 2024: hallucinated name registered as an empty proof-of-concept package'),
  ('npm', 'react-codeshift', now(), '{}', 1, false, null,
   'Aikido Security, Jan 2026: conflation of jscodeshift + react-codemod spread via agent skills (verify)')
on conflict (ecosystem, name) do nothing;
