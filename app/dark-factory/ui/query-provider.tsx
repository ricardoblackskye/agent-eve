"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";

/**
 * One query client for the dark factory subtree.
 *
 * A client component inside a server layout, so the pages below it can hold their
 * own query state without any of them creating a client of its own.
 */
export function QueryProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
