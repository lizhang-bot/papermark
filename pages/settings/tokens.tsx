import { useRouter } from "next/router";

import { type ReactNode, useEffect, useMemo, useState } from "react";

import { useTeam } from "@/context/team-context";
import { format } from "date-fns";
import { CircleHelpIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";

import { cn, copyToClipboard, fetcher } from "@/lib/utils";

import AppLayout from "@/components/layouts/app";
import { SettingsHeader } from "@/components/settings/settings-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { BadgeTooltip } from "@/components/ui/tooltip";

type TokenSubjectType = "user" | "machine";

interface Token {
  id: string;
  name: string;
  partialKey: string;
  subjectType: TokenSubjectType;
  scopes: string | null;
  createdAt: string;
  lastUsed: string | null;
  user: {
    name: string | null;
    email: string | null;
  };
}

type Preset = "all_access" | "read_only" | "restricted";

const PRESETS: { value: Preset; label: string; description: string }[] = [
  {
    value: "all_access",
    label: "All access",
    description: "Read and write everything in the team.",
  },
  {
    value: "read_only",
    label: "Read only",
    description: "Read everything in the team. Cannot modify any data.",
  },
  {
    value: "restricted",
    label: "Restricted",
    description: "Pick the exact resources and actions this token can access.",
  },
];

const SCOPE_OPTIONS: { value: string; label: string; description: string }[] = [
  {
    value: "documents.read",
    label: "Documents — Read",
    description: "List and read documents",
  },
  {
    value: "documents.write",
    label: "Documents — Write",
    description: "Upload, update, delete documents",
  },
  {
    value: "links.read",
    label: "Links — Read",
    description: "List and read share links",
  },
  {
    value: "links.write",
    label: "Links — Write",
    description: "Create, update, revoke share links",
  },
  {
    value: "datarooms.read",
    label: "Datarooms — Read",
    description: "List and read datarooms",
  },
  {
    value: "datarooms.write",
    label: "Datarooms — Write",
    description: "Create and modify datarooms",
  },
  {
    value: "analytics.read",
    label: "Analytics — Read",
    description: "Read views and analytics data",
  },
  {
    value: "visitors.read",
    label: "Visitors — Read",
    description: "Read visitor records",
  },
];

const TOKEN_TYPE_OPTIONS: {
  value: TokenSubjectType;
  label: string;
  summary: string;
  tooltip: ReactNode;
}[] = [
  {
    value: "user",
    label: "You",
    summary: "Revoked automatically when your workspace access ends.",
    tooltip: (
      <>
        This API key is tied to your user account. If you are removed from the
        workspace, it will stop working automatically.
      </>
    ),
  },
  {
    value: "machine",
    label: "Machine",
    summary: "Best for CI, servers, and long-lived automations.",
    tooltip: (
      <>
        Machine keys stay valid even if the creator leaves the workspace. Use
        them for bots, deployments, and background jobs.
      </>
    ),
  },
];

const TOKEN_TYPE_LABELS: Record<TokenSubjectType, string> = {
  user: "User key",
  machine: "Machine key",
};

function presetToScopes(preset: Preset, restricted: Set<string>): string[] {
  if (preset === "all_access") return ["apis.all"];
  if (preset === "read_only") return ["apis.read"];
  return Array.from(restricted);
}

export default function TokenSettings() {
  const teamInfo = useTeam();
  const teamId = teamInfo?.currentTeam?.id;
  const router = useRouter();
  const [name, setName] = useState("");
  const [subjectType, setSubjectType] = useState<TokenSubjectType>("user");
  const [preset, setPreset] = useState<Preset>("all_access");
  // Granular selection — only consulted when preset === "restricted".
  const [restrictedScopes, setRestrictedScopes] = useState<Set<string>>(
    () => new Set(["documents.read", "links.read"]),
  );
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const { data: features } = useSWR<{ tokens: boolean }>(
    teamId ? `/api/feature-flags?teamId=${teamId}` : null,
    fetcher,
  );

  useEffect(() => {
    if (features && !features.tokens) {
      router.push("/settings/general");
      toast.error("This feature is not available for your team");
    }
  }, [features, router]);

  const { data: tokens, mutate } = useSWR<Token[]>(
    teamId ? `/api/teams/${teamId}/tokens` : null,
    fetcher,
  );

  const toggleRestrictedScope = (scope: string) => {
    setRestrictedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const scopeList = useMemo(
    () => presetToScopes(preset, restrictedScopes),
    [preset, restrictedScopes],
  );

  const generateDisabled =
    !name.trim() ||
    isLoading ||
    (preset === "restricted" && restrictedScopes.size === 0);

  const submitToken = async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`/api/teams/${teamId}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, scopes: scopeList, subjectType }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error);
      }

      const data = await response.json();
      setToken(data.token);
      toast.success("API key created successfully");
      mutate();
    } catch (error) {
      console.error(error);
      toast.error((error as Error).message || "Failed to create API key");
    } finally {
      setIsLoading(false);
    }
  };

  const generateToken = () => {
    if (preset === "restricted" && restrictedScopes.size === 0) {
      toast.error("Select at least one scope for this token");
      return;
    }
    void submitToken();
  };

  const selectedTokenType = useMemo(
    () => TOKEN_TYPE_OPTIONS.find((option) => option.value === subjectType),
    [subjectType],
  );

  const deleteToken = async (tokenId: string) => {
    try {
      const response = await fetch(`/api/teams/${teamId}/tokens`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error);
      }

      mutate();
      toast.success("API key revoked successfully");
    } catch (error) {
      console.error(error);
      toast.error((error as Error).message || "Failed to revoke API key");
    }
  };

  return (
    <AppLayout>
      <main className="relative mx-2 mb-10 mt-4 space-y-8 overflow-hidden px-1 sm:mx-3 md:mx-5 md:mt-5 lg:mx-7 lg:mt-8 xl:mx-10">
        <SettingsHeader />

        <div className="rounded-lg border border-gray-200 bg-white">
          <div className="flex flex-col items-center justify-between gap-4 space-y-3 border-b border-gray-200 p-5 sm:flex-row sm:space-y-0 sm:p-10">
            <div className="flex max-w-screen-sm flex-col space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-medium text-gray-900">API Keys</h2>
                <BadgeTooltip content="Use these tokens to authenticate your API requests">
                  <CircleHelpIcon className="h-4 w-4 text-gray-500" />
                </BadgeTooltip>
              </div>
              <p className="text-sm text-gray-500">
                Create scoped API keys for your apps, automation, and MCP
                clients. Keep them secure and never share them publicly.
              </p>
            </div>
          </div>

          <div className="p-5 sm:p-10">
            <div className="flex flex-col space-y-4">
              <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4 sm:p-6">
                <div>
                  <Label htmlFor="token-name" className="text-gray-900">
                    Name
                  </Label>
                  <Input
                    id="token-name"
                    placeholder="Enter a name for your token"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-2 text-gray-900 dark:bg-white"
                  />
                </div>

                <div className="mt-5">
                  <div className="flex items-center gap-2">
                    <Label className="text-gray-900">Type</Label>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    Choose whether this key should follow your workspace access
                    or stay durable for automation.
                  </p>

                  <RadioGroup
                    value={subjectType}
                    onValueChange={(value) =>
                      setSubjectType(value as TokenSubjectType)
                    }
                    className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    {TOKEN_TYPE_OPTIONS.map((option) => {
                      const active = option.value === subjectType;
                      return (
                        <label
                          key={option.value}
                          htmlFor={`subject-type-${option.value}`}
                          className={cn(
                            "group cursor-pointer rounded-xl border bg-white p-4 transition-all",
                            active
                              ? "border-gray-900 shadow-[0_0_0_1px_rgba(17,24,39,1)]"
                              : "border-gray-200 hover:border-gray-300 hover:bg-gray-50",
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-3">
                              <RadioGroupItem
                                value={option.value}
                                id={`subject-type-${option.value}`}
                                className="mt-0.5"
                              />
                              <div className="space-y-1">
                                <div className="font-medium text-gray-900">
                                  {option.label}
                                </div>
                                <p className="text-sm leading-5 text-gray-500">
                                  {option.summary}
                                </p>
                              </div>
                            </div>

                            <BadgeTooltip
                              content={option.tooltip}
                              className="max-w-80 text-left leading-6 text-gray-600"
                            >
                              <CircleHelpIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400 transition-colors group-hover:text-gray-600" />
                            </BadgeTooltip>
                          </div>
                        </label>
                      );
                    })}
                  </RadioGroup>

                  <p className="mt-3 rounded-lg border border-dashed border-gray-200 bg-white/80 px-3 py-2 text-xs text-gray-600">
                    <span className="font-medium text-gray-900">
                      {TOKEN_TYPE_LABELS[subjectType]}
                    </span>{" "}
                    {selectedTokenType ? selectedTokenType.summary : null}
                  </p>
                </div>
              </div>

              <div>
                <Label className="text-gray-900">Permissions</Label>
                <p className="text-xs text-gray-500">
                  Pick a preset or restrict the token to specific resources.
                </p>
                <div
                  role="radiogroup"
                  aria-label="Token permissions preset"
                  className="mt-3 grid grid-cols-1 overflow-hidden rounded-md border border-gray-200 bg-gray-50 sm:grid-cols-3"
                >
                  {PRESETS.map((p) => {
                    const active = preset === p.value;
                    return (
                      <button
                        type="button"
                        key={p.value}
                        role="radio"
                        aria-checked={active}
                        onClick={() => setPreset(p.value)}
                        className={cn(
                          "flex h-9 items-center justify-center text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400",
                          active
                            ? "bg-white font-medium text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300"
                            : "text-gray-600 hover:bg-gray-100",
                        )}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  This API key will have{" "}
                  <span className="font-medium text-gray-700">
                    {PRESETS.find((p) => p.value === preset)?.description}
                  </span>
                </p>

                {preset === "restricted" && (
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {SCOPE_OPTIONS.map((opt) => (
                      <label
                        key={opt.value}
                        className="flex cursor-pointer items-start gap-2 rounded border border-gray-200 p-2 text-sm text-gray-900 hover:bg-gray-50"
                      >
                        <Checkbox
                          checked={restrictedScopes.has(opt.value)}
                          onCheckedChange={() =>
                            toggleRestrictedScope(opt.value)
                          }
                        />
                        <div className="space-y-0.5">
                          <div className="font-medium">{opt.label}</div>
                          <div className="text-xs text-gray-500">
                            {opt.description}
                          </div>
                          <code className="text-[10px] text-gray-400">
                            {opt.value}
                          </code>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {token && (
                <div className="rounded-lg bg-gray-50 p-4 text-gray-900">
                  <div className="flex items-center gap-2">
                    <Label>
                      Your API key (copy it now, it won&apos;t be shown again)
                    </Label>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() =>
                        copyToClipboard(`${token}`, "Token copied to clipboard")
                      }
                    >
                      <CopyIcon />
                    </Button>
                  </div>
                  <code className="mt-2 block break-all rounded bg-gray-100 p-2 font-mono text-sm">
                    {token}
                  </code>
                </div>
              )}

              <Button
                onClick={generateToken}
                disabled={generateDisabled}
                className="w-full bg-gray-900 text-gray-50 hover:bg-gray-900/90"
              >
                {isLoading ? "Creating API key..." : "Create API key"}
              </Button>

              <div className="mt-8">
                <h3 className="mb-4 text-lg font-medium text-gray-900">
                  Existing Keys
                </h3>
                <div className="rounded-lg border border-gray-200">
                  {tokens?.length === 0 ? (
                    <div className="p-4 text-center text-sm text-gray-500">
                      No API keys created yet
                    </div>
                  ) : (
                    <div className="divide-y divide-gray-200">
                      {tokens?.map((t) => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between p-4"
                        >
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <p className="font-medium text-gray-900">
                                {t.name}
                              </p>
                              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-gray-600">
                                {TOKEN_TYPE_LABELS[t.subjectType]}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-500">
                              <span className="font-mono">{t.partialKey}</span>
                              <span>•</span>
                              <span>
                                Created by{" "}
                                {t.user.name ?? t.user.email ?? "Unknown user"}
                              </span>
                              <span>•</span>
                              <span>
                                {format(new Date(t.createdAt), "MMM d, yyyy")}
                              </span>
                              {t.lastUsed ? (
                                <>
                                  <span>•</span>
                                  <span>
                                    Last used{" "}
                                    {format(
                                      new Date(t.lastUsed),
                                      "MMM d, yyyy",
                                    )}
                                  </span>
                                </>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap gap-1 pt-1">
                              {(() => {
                                const list = t.scopes
                                  ? t.scopes.split(/\s+/)
                                  : ["apis.all"];
                                const isPreset = list.some(
                                  (s) => s === "apis.all" || s === "apis.read",
                                );
                                return list.map((s) => (
                                  <code
                                    key={s}
                                    className={cn(
                                      "rounded px-1.5 py-0.5 text-[10px]",
                                      isPreset
                                        ? "bg-amber-100 text-amber-700"
                                        : "bg-gray-100 text-gray-700",
                                    )}
                                  >
                                    {s}
                                  </code>
                                ));
                              })()}
                            </div>
                          </div>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => deleteToken(t.id)}
                          >
                            Revoke
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </AppLayout>
  );
}
