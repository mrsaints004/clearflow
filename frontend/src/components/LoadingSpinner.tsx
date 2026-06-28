import React from "react";

interface Props {
  size?: "sm" | "md" | "lg";
  label?: string;
}

export default function LoadingSpinner({ size = "sm", label = "Loading" }: Props) {
  return (
    <span className={`spinner spinner-${size}`} role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
    </span>
  );
}
