import { useState } from "react";

import { useTeam } from "@/context/team-context";
import { LinkIcon, UsersIcon } from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";

import { cn, fetcher } from "@/lib/utils";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

type DefaultPermissionStrategy =
  | "INHERIT_FROM_PARENT"
  | "ASK_EVERY_TIME"
  | "HIDDEN_BY_DEFAULT";

type PermissionField =
  | "defaultPermissionStrategy"
  | "defaultGroupPermissionStrategy";

interface DataroomPermissionData {
  id: string;
  name: string;
  pId: string;
  defaultPermissionStrategy: DefaultPermissionStrategy;
  defaultGroupPermissionStrategy: DefaultPermissionStrategy;
}

interface PermissionSettingsProps {
  dataroomId: string;
}

const STRATEGY_OPTIONS: {
  value: DefaultPermissionStrategy;
  label: string;
  description: string;
}[] = [
  {
    value: "INHERIT_FROM_PARENT",
    label: "Inherit from parent folder",
    description:
      "New documents and folders inherit permissions from their parent folder. Root-level items get view-only by default.",
  },
  {
    value: "ASK_EVERY_TIME",
    label: "Ask every time",
    description:
      "Show a permissions dialog after each upload to configure access manually.",
  },
  {
    value: "HIDDEN_BY_DEFAULT",
    label: "Hidden by default",
    description:
      "New documents and folders are hidden. Grant access manually before they become visible.",
  },
];

const SCOPES: {
  key: PermissionField;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    key: "defaultGroupPermissionStrategy",
    label: "Groups",
    icon: UsersIcon,
  },
  {
    key: "defaultPermissionStrategy",
    label: "Links",
    icon: LinkIcon,
  },
];

export default function PermissionSettings({
  dataroomId,
}: PermissionSettingsProps) {
  const teamInfo = useTeam();
  const teamId = teamInfo?.currentTeam?.id;

  const { data: dataroomData, mutate: mutateDataroom } =
    useSWR<DataroomPermissionData>(
      teamId && dataroomId
        ? `/api/teams/${teamId}/datarooms/${dataroomId}`
        : null,
      fetcher,
    );

  const [updatingField, setUpdatingField] = useState<PermissionField | null>(
    null,
  );

  const handlePermissionChange = async (
    field: PermissionField,
    value: DefaultPermissionStrategy,
  ) => {
    if (!dataroomId || !teamId || updatingField || !dataroomData) return;
    setUpdatingField(field);

    const optimisticData: DataroomPermissionData = {
      ...dataroomData,
      [field]: value,
    };

    const mutation = async () => {
      const res = await fetch(`/api/teams/${teamId}/datarooms/${dataroomId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });

      if (!res.ok) {
        throw new Error("Failed to update permission settings");
      }

      return res.json();
    };

    try {
      await toast.promise(
        mutateDataroom(mutation(), {
          optimisticData,
          rollbackOnError: true,
          populateCache: true,
          revalidate: false,
        }),
        {
          loading: "Updating permission settings...",
          success: "Permission settings updated",
          error: (err) => err.message,
        },
      );
    } catch (error) {
      console.error(error);
    } finally {
      setUpdatingField(null);
    }
  };

  const values: Record<PermissionField, DefaultPermissionStrategy> = {
    defaultGroupPermissionStrategy:
      dataroomData?.defaultGroupPermissionStrategy ?? "INHERIT_FROM_PARENT",
    defaultPermissionStrategy:
      dataroomData?.defaultPermissionStrategy ?? "INHERIT_FROM_PARENT",
  };

  const disabled = updatingField !== null || !dataroomData;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default File Permissions</CardTitle>
        <CardDescription>
          Configure how new documents and folders are exposed to groups and
          links. Each scope is set independently.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[1fr_auto] gap-x-8 gap-y-1">
          <div />
          <div className="flex items-center gap-1">
            {SCOPES.map((scope) => (
              <div
                key={scope.key}
                className="flex w-20 items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                <scope.icon className="h-3 w-3" />
                {scope.label}
              </div>
            ))}
          </div>

          {STRATEGY_OPTIONS.map((option, index) => (
            <StrategyRow
              key={option.value}
              option={option}
              values={values}
              disabled={disabled}
              isFirst={index === 0}
              onChange={handlePermissionChange}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function StrategyRow({
  option,
  values,
  disabled,
  isFirst,
  onChange,
}: {
  option: (typeof STRATEGY_OPTIONS)[number];
  values: Record<PermissionField, DefaultPermissionStrategy>;
  disabled: boolean;
  isFirst: boolean;
  onChange: (
    field: PermissionField,
    value: DefaultPermissionStrategy,
  ) => void;
}) {
  return (
    <>
      <div
        className={cn(
          "py-3",
          !isFirst && "border-t border-border/60",
        )}
      >
        <Label
          htmlFor={`group-${option.value}`}
          className="text-sm font-medium"
        >
          {option.label}
        </Label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {option.description}
        </p>
      </div>
      <div
        className={cn(
          "flex items-center gap-1 py-3",
          !isFirst && "border-t border-border/60",
        )}
      >
        {SCOPES.map((scope) => (
          <div
            key={scope.key}
            className="flex w-20 items-center justify-center"
          >
            <RadioGroup
              value={values[scope.key]}
              onValueChange={(value) =>
                onChange(scope.key, value as DefaultPermissionStrategy)
              }
              disabled={disabled}
              aria-label={`${scope.label} default`}
            >
              <RadioGroupItem
                value={option.value}
                id={`${scope.key}-${option.value}`}
                aria-label={`${option.label} for ${scope.label.toLowerCase()}`}
              />
            </RadioGroup>
          </div>
        ))}
      </div>
    </>
  );
}
