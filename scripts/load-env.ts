/* Loads env files the same way Next does: .env.development* locally, .env.production* when NODE_ENV=production.
   Real environment variables always win, so production reads DATABASE_URL from the host. */
import { config } from "dotenv";

const mode = process.env.NODE_ENV === "production" ? "production" : "development";
config({ path: [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"], quiet: true });
