import { createClient } from "@supabase/supabase-js";
import { validateSupabaseConfig } from "../config/config.js";

const { url, secretKey } = validateSupabaseConfig();

export const supabase = createClient(url, secretKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

export default supabase;
