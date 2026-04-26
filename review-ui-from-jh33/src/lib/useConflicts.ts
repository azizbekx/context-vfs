/**
 * useConflicts — react-query hook that pulls /conflicts from the backend
 * and runs the adapter so the Review screen always sees ConflictItem[].
 */

import { useQuery } from "@tanstack/react-query";
import { fetchConflicts } from "./api";
import { adaptAll } from "./conflict-adapter";
import type { ConflictItem } from "./review-data";

export interface UseConflictsResult {
  data: ConflictItem[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

export function useConflicts(status?: string): UseConflictsResult {
  const q = useQuery({
    queryKey: ["conflicts", status ?? "all"],
    queryFn: async () => {
      const response = await fetchConflicts(status);
      return adaptAll(response.conflicts);
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  return {
    data: q.data,
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error,
    refetch: () => q.refetch(),
  };
}
