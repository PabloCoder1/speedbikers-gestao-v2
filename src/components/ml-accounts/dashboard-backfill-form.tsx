"use client";

import {
  useActionState,
} from "react";

import { Button } from "@/components/ui/button";

import {
  startDashboardBackfillAction,
  type StartDashboardBackfillState,
} from "@/features/ml-sync/actions";


type DashboardBackfillFormProps = {
  mlAccountId: string;
};


const initialState:
  StartDashboardBackfillState = {
    error:
      null,

    success:
      null,
  };


export function DashboardBackfillForm({
  mlAccountId,
}: DashboardBackfillFormProps) {
  const action =
    startDashboardBackfillAction.bind(
      null,
      mlAccountId,
    );


  const [
    state,
    formAction,
    pending,
  ] = useActionState(
    action,
    initialState,
  );


  return (
    <form
      action={formAction}
      className="mt-3"
    >
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        disabled={pending}
        className="w-full"
      >
        {pending
          ? "Priorizando..."
          : "Priorizar últimos 90 dias"}
      </Button>


      {state.success ? (
        <p className="mt-3 text-xs leading-5 text-green-700">
          {state.success}
        </p>
      ) : null}


      {state.error ? (
        <p
          role="alert"
          className="mt-3 text-xs leading-5 text-red-700"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
