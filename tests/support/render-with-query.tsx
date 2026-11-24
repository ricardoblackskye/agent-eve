import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

/**
 * Renders a dark factory page inside a query client, the way the layout does in the app.
 *
 * Without this a page that reads through a query renders bare in its test and throws
 * "No QueryClient set" - a page-level break that a layout-level assertion cannot see.
 * The client is created per render, with the same no-cache, no-retry posture as production.
 */
export function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
