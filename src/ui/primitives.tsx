import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-gray-200 bg-white p-4 shadow-sm ${className}`}>{children}</section>;
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-4">
      <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
      {description ? <p className="mt-1 text-sm text-gray-600">{description}</p> : null}
    </header>
  );
}
