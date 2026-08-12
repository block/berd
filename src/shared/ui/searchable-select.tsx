import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button } from "@/shared/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { cn } from "@/shared/lib/cn";

interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  value: string;
  options: SearchableSelectOption[];
  onValueChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  className?: string;
}

export function SearchableSelect({
  value,
  options,
  onValueChange,
  id,
  disabled = false,
  placeholder = "Select an option",
  searchPlaceholder = "Search...",
  emptyLabel = "No results found.",
  className,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const generatedListId = useId();
  const listId = id ? `${id}-listbox` : generatedListId;
  const selectedOption = useMemo(
    () => options.find((option) => option.value === value),
    [options, value],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          role="combobox"
          aria-controls={listId}
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          variant="outline"
          className={cn(
            "h-9 w-full justify-between px-3 font-normal",
            !selectedOption && "text-muted-foreground",
            className,
          )}
          rightIcon={<ChevronsUpDownIcon className="size-4 opacity-50" />}
        >
          <span className="truncate">
            {selectedOption?.label ?? (value || placeholder)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList id={listId}>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => {
                    onValueChange(option.value);
                    setOpen(false);
                  }}
                >
                  <CheckIcon
                    className={cn(
                      "size-4",
                      option.value === value ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
