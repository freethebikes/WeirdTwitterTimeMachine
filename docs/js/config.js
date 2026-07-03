// Weird Twitter Time Machine configuration.
//
// Fill these in to serve posts and replies from Supabase (see README.md):
// run supabase/schema.sql, import with scripts/import-supabase.mjs, then put
// your project URL and anon (public) key here. The anon key is safe to ship
// in a public site; row level security limits it to reading, plus inserting
// replies.
//
// Leave both blank to run fully static: posts load from the bundled JSON in
// data/ and replies are kept in your browser's localStorage.
window.WTTM_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
};
