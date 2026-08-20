export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      erp_import_batches: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          content_hash: string
          created_at: string
          file_name: string | null
          id: string
          invalid_rows: number | null
          kind: string
          last_error: string | null
          ok_rows: number | null
          organization_id: string
          parsed_at: string | null
          skipped_rows: number | null
          status: string
          storage_path: string
          total_rows: number | null
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          content_hash: string
          created_at?: string
          file_name?: string | null
          id?: string
          invalid_rows?: number | null
          kind: string
          last_error?: string | null
          ok_rows?: number | null
          organization_id: string
          parsed_at?: string | null
          skipped_rows?: number | null
          status?: string
          storage_path: string
          total_rows?: number | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          content_hash?: string
          created_at?: string
          file_name?: string | null
          id?: string
          invalid_rows?: number | null
          kind?: string
          last_error?: string | null
          ok_rows?: number | null
          organization_id?: string
          parsed_at?: string | null
          skipped_rows?: number | null
          status?: string
          storage_path?: string
          total_rows?: number | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "erp_import_batches_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "erp_import_batches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "erp_import_batches_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      erp_import_rows: {
        Row: {
          batch_id: string
          created_at: string
          id: number
          payload: Json
          reason: string | null
          row_number: number
          sku_key: string | null
          status: string
        }
        Insert: {
          batch_id: string
          created_at?: string
          id?: never
          payload: Json
          reason?: string | null
          row_number: number
          sku_key?: string | null
          status: string
        }
        Update: {
          batch_id?: string
          created_at?: string
          id?: never
          payload?: Json
          reason?: string | null
          row_number?: number
          sku_key?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "erp_import_rows_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "erp_import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      erp_stock_snapshots: {
        Row: {
          available: number
          average_cost: number | null
          batch_id: string
          captured_at: string
          created_at: string
          id: number
          in_transit: number
          on_hand: number
          organization_id: string
          reserved: number
          sku_id: string | null
          sku_key: string
          warehouse: string
        }
        Insert: {
          available: number
          average_cost?: number | null
          batch_id: string
          captured_at: string
          created_at?: string
          id?: never
          in_transit?: number
          on_hand: number
          organization_id: string
          reserved?: number
          sku_id?: string | null
          sku_key: string
          warehouse: string
        }
        Update: {
          available?: number
          average_cost?: number | null
          batch_id?: string
          captured_at?: string
          created_at?: string
          id?: never
          in_transit?: number
          on_hand?: number
          organization_id?: string
          reserved?: number
          sku_id?: string | null
          sku_key?: string
          warehouse?: string
        }
        Relationships: [
          {
            foreignKeyName: "erp_stock_snapshots_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "erp_import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "erp_stock_snapshots_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "erp_stock_snapshots_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      job_runs: {
        Row: {
          attempt: number
          created_at: string
          dedupe_key: string
          duration_ms: number | null
          finished_at: string
          id: string
          job_id: string
          job_type: string
          organization_id: string
          processed: number | null
          reason: string | null
          retryable: boolean | null
          started_at: string
          status: string
        }
        Insert: {
          attempt: number
          created_at?: string
          dedupe_key: string
          duration_ms?: number | null
          finished_at: string
          id?: string
          job_id: string
          job_type: string
          organization_id: string
          processed?: number | null
          reason?: string | null
          retryable?: boolean | null
          started_at: string
          status: string
        }
        Update: {
          attempt?: number
          created_at?: string
          dedupe_key?: string
          duration_ms?: number | null
          finished_at?: string
          id?: string
          job_id?: string
          job_type?: string
          organization_id?: string
          processed?: number | null
          reason?: string | null
          retryable?: boolean | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      ml_accounts: {
        Row: {
          connected_at: string | null
          created_at: string
          id: string
          label: string
          last_error: string | null
          nickname: string | null
          organization_id: string
          seller_id: number | null
          slug: string
          status: string
          updated_at: string
        }
        Insert: {
          connected_at?: string | null
          created_at?: string
          id?: string
          label: string
          last_error?: string | null
          nickname?: string | null
          organization_id: string
          seller_id?: number | null
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          connected_at?: string | null
          created_at?: string
          id?: string
          label?: string
          last_error?: string | null
          nickname?: string | null
          organization_id?: string
          seller_id?: number | null
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ml_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ml_credentials: {
        Row: {
          access_token_ciphertext: string
          access_token_expires_at: string
          created_at: string
          encryption_key_version: number
          ml_account_id: string
          refresh_locked_until: string | null
          refresh_token_ciphertext: string
          scopes: string[] | null
          updated_at: string
        }
        Insert: {
          access_token_ciphertext: string
          access_token_expires_at: string
          created_at?: string
          encryption_key_version?: number
          ml_account_id: string
          refresh_locked_until?: string | null
          refresh_token_ciphertext: string
          scopes?: string[] | null
          updated_at?: string
        }
        Update: {
          access_token_ciphertext?: string
          access_token_expires_at?: string
          created_at?: string
          encryption_key_version?: number
          ml_account_id?: string
          refresh_locked_until?: string | null
          refresh_token_ciphertext?: string
          scopes?: string[] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ml_credentials_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: true
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      ml_oauth_states: {
        Row: {
          consumed_at: string | null
          created_at: string
          created_by: string | null
          expires_at: string
          ml_account_id: string
          organization_id: string
          redirect_to: string | null
          state: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          created_by?: string | null
          expires_at: string
          ml_account_id: string
          organization_id: string
          redirect_to?: string | null
          state: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string
          ml_account_id?: string
          organization_id?: string
          redirect_to?: string | null
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "ml_oauth_states_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ml_oauth_states_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ml_oauth_states_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          organization_id: string
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          role: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      sku_components: {
        Row: {
          component_sku_id: string
          created_at: string
          kit_sku_id: string
          quantity: number
          updated_at: string
        }
        Insert: {
          component_sku_id: string
          created_at?: string
          kit_sku_id: string
          quantity: number
          updated_at?: string
        }
        Update: {
          component_sku_id?: string
          created_at?: string
          kit_sku_id?: string
          quantity?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sku_components_component_sku_id_fkey"
            columns: ["component_sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_components_kit_sku_id_fkey"
            columns: ["kit_sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_listing_links: {
        Row: {
          channel_sku: string | null
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          id: string
          item_id: string | null
          ml_account_id: string
          organization_id: string
          ref_kind: string
          sku_id: string
          source: string
          updated_at: string
          user_product_id: string | null
          variation_id: string | null
        }
        Insert: {
          channel_sku?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          id?: string
          item_id?: string | null
          ml_account_id: string
          organization_id: string
          ref_kind: string
          sku_id: string
          source?: string
          updated_at?: string
          user_product_id?: string | null
          variation_id?: string | null
        }
        Update: {
          channel_sku?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          id?: string
          item_id?: string | null
          ml_account_id?: string
          organization_id?: string
          ref_kind?: string
          sku_id?: string
          source?: string
          updated_at?: string
          user_product_id?: string | null
          variation_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sku_listing_links_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_listing_links_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_listing_links_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_listing_links_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      skus: {
        Row: {
          barcode: string | null
          brand: string | null
          category_raw: string | null
          cest: string | null
          created_at: string
          erp_product_code: string | null
          erp_spu: string | null
          height_cm: number | null
          id: string
          image_url: string | null
          is_active: boolean
          is_discontinued: boolean
          is_imported: boolean | null
          kind: string
          length_cm: number | null
          ncm: string | null
          organization_id: string
          origin_code: number | null
          purchase_cost: number | null
          retail_price: number | null
          sku: string
          sku_key: string
          title: string | null
          unit: string | null
          updated_at: string
          weight_g: number | null
          width_cm: number | null
        }
        Insert: {
          barcode?: string | null
          brand?: string | null
          category_raw?: string | null
          cest?: string | null
          created_at?: string
          erp_product_code?: string | null
          erp_spu?: string | null
          height_cm?: number | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          is_discontinued?: boolean
          is_imported?: boolean | null
          kind?: string
          length_cm?: number | null
          ncm?: string | null
          organization_id: string
          origin_code?: number | null
          purchase_cost?: number | null
          retail_price?: number | null
          sku: string
          sku_key?: string
          title?: string | null
          unit?: string | null
          updated_at?: string
          weight_g?: number | null
          width_cm?: number | null
        }
        Update: {
          barcode?: string | null
          brand?: string | null
          category_raw?: string | null
          cest?: string | null
          created_at?: string
          erp_product_code?: string | null
          erp_spu?: string | null
          height_cm?: number | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          is_discontinued?: boolean
          is_imported?: boolean | null
          kind?: string
          length_cm?: number | null
          ncm?: string | null
          organization_id?: string
          origin_code?: number | null
          purchase_cost?: number | null
          retail_price?: number | null
          sku?: string
          sku_key?: string
          title?: string | null
          unit?: string | null
          updated_at?: string
          weight_g?: number | null
          width_cm?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "skus_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_account_permissions: {
        Row: {
          created_at: string
          ml_account_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          ml_account_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          ml_account_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_account_permissions_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_account_permissions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

