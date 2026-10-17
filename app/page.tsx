import { runtimeConfig } from "@/lib/runtime-config";
export const dynamic = "force-dynamic";
import Workspace from "./workspace";
export default function Page() {
  return <Workspace cloud={runtimeConfig().mode === "cloud"} />;
}
