"use client";

import { useSearchParams } from "next/navigation";
import { PhoneSender } from "./phone-sender";

export function SendPageContent() {
  const searchParams = useSearchParams();
  const code = searchParams.get("code") ?? "";

  return <PhoneSender initialCode={code} />;
}
