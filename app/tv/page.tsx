import type { Metadata } from "next";
import { TvReceiver } from "./tv-receiver";

export const metadata: Metadata = {
  title: "TV receiver",
  description: "Receive a file from your phone over the local Wi-Fi.",
};

export default function TvPage() {
  return <TvReceiver />;
}
