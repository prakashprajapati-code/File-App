import type { Metadata } from "next";
import { Suspense } from "react";
import { LogPanel } from "@/components/LogPanel";
import { StatusScreen } from "@/components/StatusScreen";
import { SendPageContent } from "./send-page-content";

export const metadata: Metadata = {
  title: "Send a file",
  description: "Pair with the TV and send a file over your local Wi-Fi.",
};

export default function SendPage() {
  return (
    <>
      <Suspense fallback={<StatusScreen title="Loading..." />}>
        <SendPageContent />
      </Suspense>
      <LogPanel role="phone" />
    </>
  );
}
