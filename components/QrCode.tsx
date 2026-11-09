"use client";

import { QRCodeSVG } from "qrcode.react";

interface QrCodeProps {
  value: string;
  size?: number;
}

export function QrCode({ value, size = 320 }: QrCodeProps) {
  return (
    <div className="rounded-3xl bg-white p-5 shadow-lg">
      <QRCodeSVG
        value={value}
        size={size}
        level="M"
        marginSize={2}
        title="Scan this code with your phone camera"
      />
    </div>
  );
}
