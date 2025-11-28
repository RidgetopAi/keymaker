-- Migration 002: Add 'narrative' category to distilled_state
-- 
-- This adds the identity layer to Keymaker's living summaries.
-- The 'narrative' category tracks who Brian is, his values, and who he's becoming.
-- It's deeper than mood (how he feels) - it's about identity and self-understanding.
--
-- Instance #28: What makes a good memory? One that helps you understand yourself.

INSERT INTO distilled_state (key, content) VALUES
  ('narrative', 'No self-narrative developed yet. This will evolve as Brian shares reflections about who he is, what he values, and how he''s growing.')
ON CONFLICT (key) DO NOTHING;

-- Verify the addition
-- SELECT key, LEFT(content, 50) as preview FROM distilled_state ORDER BY key;
