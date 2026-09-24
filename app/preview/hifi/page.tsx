import { notFound } from "next/navigation";
import { HifiFrames } from "./frames";
import { hifiPreviewAllowed } from "./gate";

export const metadata = { title: "Hi-fi preview" };

export default function HifiPreviewPage() {
  if (!hifiPreviewAllowed()) notFound();
  return <HifiFrames />;
}
