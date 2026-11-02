import { BRAND } from "@/lib/brand";

/** Who serves the models, linked and recessed beside the app's mark. Plain type: no third-party logo is bundled. */
export function ProviderLink({ className = "" }: { className?: string }) {
  return (
    <a
      href={BRAND.providerUrl}
      target="_blank"
      rel="noopener noreferrer"
      data-tip="Models served through OpenRouter"
      className={`flex h-9 shrink-0 items-center rounded-sm font-sans text-[13.5px] font-medium tracking-[-0.01em] text-ink opacity-60 transition-opacity duration-200 hover:opacity-100 ${className}`}
    >
      OpenRouter
    </a>
  );
}
