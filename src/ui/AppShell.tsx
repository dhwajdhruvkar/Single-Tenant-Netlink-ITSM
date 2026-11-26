import type { ReactNode } from "react";

// Application shell. Navigation items are role-aware from Phase 3; for now it is a static frame.
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-gray-50 text-gray-900">
      <header className="flex h-12 items-center border-b border-gray-200 bg-white px-4">
        <span className="text-sm font-semibold">Netlink ITSM</span>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 p-6">{children}</main>
    </div>
  );
}
