import { notFound } from "next/navigation";
import DefectsClient from "./DefectsClient";

/** Dev-only route: 404s in production builds. */
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DefectsClient />;
}
