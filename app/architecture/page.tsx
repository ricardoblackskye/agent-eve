import { redirect } from "next/navigation";

/**
 * `/architecture` moved to `/documentation` (#234). The content was split into a
 * docs/ tree; this keeps existing links and bookmarks working rather than 404ing.
 */
export default function ArchitectureRedirect() {
  redirect("/documentation");
}
