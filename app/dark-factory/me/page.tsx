"use client";

import { CustomerViewContainer } from "../ui/customer-view";

/**
 * The customer route (#215, epic #212 R3) — a view of one customer's own runs,
 * usage and budget. Every figure is scoped server-side from the caller's
 * membership, so this page carries no scope logic and offers no controls.
 */
export default function CustomerAccountPage() {
  return <CustomerViewContainer />;
}
