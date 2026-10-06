import { apiRouter } from "@/server/api";
import { checkDbRole } from "@/server/dbcheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handle = async (req: Request) => {
  await checkDbRole();
  return apiRouter().handle(req, "/api/v1");
};
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
