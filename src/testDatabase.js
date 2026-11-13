async function runDatabaseTest() {
  try {
    const { supabase } = await import("./services/database.js");

    const { data, error } = await supabase
      .from("family_members")
      .select("id")
      .limit(1);

    if (error) {
      console.error(`[Supabase] Database query failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    console.log("[Supabase] Connected successfully.");
    console.log("[Supabase] Database query successful.");
    console.log(`[Supabase] Rows returned: ${data?.length ?? 0}`);
  } catch (error) {
    console.error(`[Supabase] Connection failed: ${error.message}`);
    process.exitCode = 1;
  }
}

runDatabaseTest();
