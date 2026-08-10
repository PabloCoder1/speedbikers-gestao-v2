"use client";

import {
  useActionState,
} from "react";

import { Button } from "@/components/ui/button";

import {
  syncOrdersPreviewAction,
  type SyncOrdersPreviewState,
} from "@/features/ml-sync/actions";


type OrdersSyncFormProps = {
  mlAccountId: string;
};


const initialState:
  SyncOrdersPreviewState = {
    error: null,
    success: null,
  };


export function OrdersSyncForm({
  mlAccountId,
}: OrdersSyncFormProps) {
  const action =
    syncOrdersPreviewAction.bind(
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
          ? "Importando pedidos..."
          : "Importar 50 pedidos de teste"}
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