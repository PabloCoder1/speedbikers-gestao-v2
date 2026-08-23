export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      daily_account_metrics: {
        Row: {
          average_selling_price: number | null
          average_ticket: number | null
          computed_at: string
          gross_revenue: number
          id: string
          metric_date: string
          ml_account_id: string
          orders_count: number
          organization_id: string
          purchases_count: number
          units_sold: number
        }
        Insert: {
          average_selling_price?: number | null
          average_ticket?: number | null
          computed_at?: string
          gross_revenue: number
          id?: string
          metric_date: string
          ml_account_id: string
          orders_count: number
          organization_id: string
          purchases_count: number
          units_sold: number
        }
        Update: {
          average_selling_price?: number | null
          average_ticket?: number | null
          computed_at?: string
          gross_revenue?: number
          id?: string
          metric_date?: string
          ml_account_id?: string
          orders_count?: number
          organization_id?: string
          purchases_count?: number
          units_sold?: number
        }
        Relationships: [
          {
            foreignKeyName: "daily_account_metrics_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_account_metrics_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_listing_metrics: {
        Row: {
          average_selling_price: number | null
          average_ticket: number | null
          computed_at: string
          gross_revenue: number
          id: string
          metric_date: string
          ml_account_id: string
          mlb_id: string
          orders_count: number
          organization_id: string
          purchases_count: number
          units_sold: number
          variation_id: string | null
        }
        Insert: {
          average_selling_price?: number | null
          average_ticket?: number | null
          computed_at?: string
          gross_revenue: number
          id?: string
          metric_date: string
          ml_account_id: string
          mlb_id: string
          orders_count: number
          organization_id: string
          purchases_count: number
          units_sold: number
          variation_id?: string | null
        }
        Update: {
          average_selling_price?: number | null
          average_ticket?: number | null
          computed_at?: string
          gross_revenue?: number
          id?: string
          metric_date?: string
          ml_account_id?: string
          mlb_id?: string
          orders_count?: number
          organization_id?: string
          purchases_count?: number
          units_sold?: number
          variation_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_listing_metrics_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_listing_metrics_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_sku_metrics: {
        Row: {
          average_selling_price: number | null
          average_ticket: number | null
          computed_at: string
          gross_revenue: number
          id: string
          metric_date: string
          ml_account_id: string
          orders_count: number
          organization_id: string
          purchases_count: number
          sku_id: string | null
          units_sold: number
        }
        Insert: {
          average_selling_price?: number | null
          average_ticket?: number | null
          computed_at?: string
          gross_revenue: number
          id?: string
          metric_date: string
          ml_account_id: string
          orders_count: number
          organization_id: string
          purchases_count: number
          sku_id?: string | null
          units_sold: number
        }
        Update: {
          average_selling_price?: number | null
          average_ticket?: number | null
          computed_at?: string
          gross_revenue?: number
          id?: string
          metric_date?: string
          ml_account_id?: string
          orders_count?: number
          organization_id?: string
          purchases_count?: number
          sku_id?: string | null
          units_sold?: number
        }
        Relationships: [
          {
            foreignKeyName: "daily_sku_metrics_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_sku_metrics_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_sku_metrics_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      document_items: {
        Row: {
          cfop: string | null
          created_at: string
          description: string
          document_id: string
          ean: string | null
          id: number
          ncm: string | null
          position: number
          quantity: number
          sku_id: string | null
          supplier_code: string
          total_value: number
          unit: string
          unit_value: number
        }
        Insert: {
          cfop?: string | null
          created_at?: string
          description: string
          document_id: string
          ean?: string | null
          id?: never
          ncm?: string | null
          position: number
          quantity: number
          sku_id?: string | null
          supplier_code: string
          total_value: number
          unit: string
          unit_value: number
        }
        Update: {
          cfop?: string | null
          created_at?: string
          description?: string
          document_id?: string
          ean?: string | null
          id?: never
          ncm?: string | null
          position?: number
          quantity?: number
          sku_id?: string | null
          supplier_code?: string
          total_value?: number
          unit?: string
          unit_value?: number
        }
        Relationships: [
          {
            foreignKeyName: "document_items_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          access_key: string | null
          applied_at: string | null
          applied_by: string | null
          content_hash: string
          created_at: string
          document_number: string | null
          document_type: string
          file_name: string | null
          id: string
          issue_date: string | null
          issuer_cnpj: string | null
          issuer_name: string | null
          last_error: string | null
          operation_type: string | null
          organization_id: string
          parsed_at: string | null
          recipient_cnpj: string | null
          recipient_name: string | null
          resolved_items: number | null
          series: string | null
          status: string
          storage_path: string
          total_items: number | null
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          access_key?: string | null
          applied_at?: string | null
          applied_by?: string | null
          content_hash: string
          created_at?: string
          document_number?: string | null
          document_type?: string
          file_name?: string | null
          id?: string
          issue_date?: string | null
          issuer_cnpj?: string | null
          issuer_name?: string | null
          last_error?: string | null
          operation_type?: string | null
          organization_id: string
          parsed_at?: string | null
          recipient_cnpj?: string | null
          recipient_name?: string | null
          resolved_items?: number | null
          series?: string | null
          status?: string
          storage_path: string
          total_items?: number | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          access_key?: string | null
          applied_at?: string | null
          applied_by?: string | null
          content_hash?: string
          created_at?: string
          document_number?: string | null
          document_type?: string
          file_name?: string | null
          id?: string
          issue_date?: string | null
          issuer_cnpj?: string | null
          issuer_name?: string | null
          last_error?: string | null
          operation_type?: string | null
          organization_id?: string
          parsed_at?: string | null
          recipient_cnpj?: string | null
          recipient_name?: string | null
          resolved_items?: number | null
          series?: string | null
          status?: string
          storage_path?: string
          total_items?: number | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      domain_events: {
        Row: {
          after: Json | null
          before: Json | null
          created_at: string
          dedup_key: string
          entity_id: string
          entity_type: string
          event_type: string
          id: string
          ml_account_id: string | null
          occurred_at: string
          organization_id: string
          severity: string
          source: string
        }
        Insert: {
          after?: Json | null
          before?: Json | null
          created_at?: string
          dedup_key: string
          entity_id: string
          entity_type: string
          event_type: string
          id?: string
          ml_account_id?: string | null
          occurred_at: string
          organization_id: string
          severity: string
          source: string
        }
        Update: {
          after?: Json | null
          before?: Json | null
          created_at?: string
          dedup_key?: string
          entity_id?: string
          entity_type?: string
          event_type?: string
          id?: string
          ml_account_id?: string | null
          occurred_at?: string
          organization_id?: string
          severity?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "domain_events_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "domain_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      erp_import_batches: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          applied_rows: number | null
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
          unresolved_rows: number | null
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          applied_rows?: number | null
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
          unresolved_rows?: number | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          applied_rows?: number | null
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
          unresolved_rows?: number | null
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
          apply_reason: string | null
          apply_status: string | null
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
          apply_reason?: string | null
          apply_status?: string | null
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
          apply_reason?: string | null
          apply_status?: string | null
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
      fulfillment_stock_snapshots: {
        Row: {
          captured_at: string
          created_at: string
          id: number
          inventory_id: string
          item_id: string
          ml_account_id: string
          organization_id: string
          quantity: number
          sku_id: string
          variation_id: string | null
        }
        Insert: {
          captured_at: string
          created_at?: string
          id?: never
          inventory_id: string
          item_id: string
          ml_account_id: string
          organization_id: string
          quantity: number
          sku_id: string
          variation_id?: string | null
        }
        Update: {
          captured_at?: string
          created_at?: string
          id?: never
          inventory_id?: string
          item_id?: string
          ml_account_id?: string
          organization_id?: string
          quantity?: number
          sku_id?: string
          variation_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fulfillment_stock_snapshots_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillment_stock_snapshots_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillment_stock_snapshots_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_balances: {
        Row: {
          id: string
          location_kind: string
          organization_id: string
          quantity: number
          sku_id: string
          updated_at: string
        }
        Insert: {
          id?: string
          location_kind: string
          organization_id: string
          quantity?: number
          sku_id: string
          updated_at?: string
        }
        Update: {
          id?: string
          location_kind?: string
          organization_id?: string
          quantity?: number
          sku_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_balances_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_balances_sku_id_fkey"
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
      link_candidates: {
        Row: {
          channel_sku: string | null
          created_at: string
          id: string
          item_id: string | null
          ml_account_id: string
          organization_id: string
          ref_kind: string
          resolution_method: string | null
          resolved_at: string | null
          resolved_by: string | null
          resolved_sku_id: string | null
          sku_key: string
          source: string
          source_row_id: number
          status: string
          updated_at: string
          user_product_id: string | null
          variation_id: string | null
        }
        Insert: {
          channel_sku?: string | null
          created_at?: string
          id?: string
          item_id?: string | null
          ml_account_id: string
          organization_id: string
          ref_kind: string
          resolution_method?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_sku_id?: string | null
          sku_key: string
          source?: string
          source_row_id: number
          status?: string
          updated_at?: string
          user_product_id?: string | null
          variation_id?: string | null
        }
        Update: {
          channel_sku?: string | null
          created_at?: string
          id?: string
          item_id?: string | null
          ml_account_id?: string
          organization_id?: string
          ref_kind?: string
          resolution_method?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_sku_id?: string | null
          sku_key?: string
          source?: string
          source_row_id?: number
          status?: string
          updated_at?: string
          user_product_id?: string | null
          variation_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "link_candidates_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "link_candidates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "link_candidates_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "link_candidates_resolved_sku_id_fkey"
            columns: ["resolved_sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "link_candidates_source_row_id_fkey"
            columns: ["source_row_id"]
            isOneToOne: false
            referencedRelation: "erp_import_rows"
            referencedColumns: ["id"]
          },
        ]
      }
      listings: {
        Row: {
          available_quantity: number
          category_id: string | null
          created_at: string
          currency_id: string
          id: string
          item_id: string
          ml_account_id: string
          organization_id: string
          price: number
          sku_id: string | null
          status: string
          synced_at: string
          title: string
          updated_at: string
        }
        Insert: {
          available_quantity: number
          category_id?: string | null
          created_at?: string
          currency_id: string
          id?: string
          item_id: string
          ml_account_id: string
          organization_id: string
          price: number
          sku_id?: string | null
          status: string
          synced_at?: string
          title: string
          updated_at?: string
        }
        Update: {
          available_quantity?: number
          category_id?: string | null
          created_at?: string
          currency_id?: string
          id?: string
          item_id?: string
          ml_account_id?: string
          organization_id?: string
          price?: number
          sku_id?: string | null
          status?: string
          synced_at?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "listings_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listings_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      metric_definitions: {
        Row: {
          cancellation_treatment: string
          definition_updated_on: string
          exclusions: string
          formula: string
          granularities: string[]
          id: string
          inclusions: string
          name: string
          source: string
          timezone: string
        }
        Insert: {
          cancellation_treatment: string
          definition_updated_on: string
          exclusions: string
          formula: string
          granularities: string[]
          id: string
          inclusions: string
          name: string
          source: string
          timezone: string
        }
        Update: {
          cancellation_treatment?: string
          definition_updated_on?: string
          exclusions?: string
          formula?: string
          granularities?: string[]
          id?: string
          inclusions?: string
          name?: string
          source?: string
          timezone?: string
        }
        Relationships: []
      }
      ml_accounts: {
        Row: {
          backfill_covered_until: string | null
          connected_at: string | null
          created_at: string
          created_by_import: boolean
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
          backfill_covered_until?: string | null
          connected_at?: string | null
          created_at?: string
          created_by_import?: boolean
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
          backfill_covered_until?: string | null
          connected_at?: string | null
          created_at?: string
          created_by_import?: boolean
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
          code_verifier_ciphertext: string | null
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
          code_verifier_ciphertext?: string | null
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
          code_verifier_ciphertext?: string | null
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
      order_items: {
        Row: {
          created_at: string
          currency_id: string
          id: string
          item_id: string
          ml_account_id: string
          order_id: number
          organization_id: string
          position: number
          quantity: number
          sale_fee: number | null
          seller_sku: string | null
          sku_id: string | null
          sku_listing_link_id: string | null
          title: string
          unit_price: number
          updated_at: string
          variation_id: string | null
        }
        Insert: {
          created_at?: string
          currency_id: string
          id?: string
          item_id: string
          ml_account_id: string
          order_id: number
          organization_id: string
          position: number
          quantity: number
          sale_fee?: number | null
          seller_sku?: string | null
          sku_id?: string | null
          sku_listing_link_id?: string | null
          title: string
          unit_price: number
          updated_at?: string
          variation_id?: string | null
        }
        Update: {
          created_at?: string
          currency_id?: string
          id?: string
          item_id?: string
          ml_account_id?: string
          order_id?: number
          organization_id?: string
          position?: number
          quantity?: number
          sale_fee?: number | null
          seller_sku?: string | null
          sku_id?: string | null
          sku_listing_link_id?: string | null
          title?: string
          unit_price?: number
          updated_at?: string
          variation_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_sku_listing_link_id_fkey"
            columns: ["sku_listing_link_id"]
            isOneToOne: false
            referencedRelation: "sku_listing_links"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          buyer_id: number | null
          cancel_reason: string | null
          created_at: string
          currency_id: string
          date_closed: string | null
          date_created: string
          date_last_updated: string
          id: number
          last_updated: string | null
          ml_account_id: string
          organization_id: string
          pack_id: number | null
          paid_amount: number | null
          status: string
          status_detail: string | null
          tags: string[]
          total_amount: number
          updated_at: string
        }
        Insert: {
          buyer_id?: number | null
          cancel_reason?: string | null
          created_at?: string
          currency_id: string
          date_closed?: string | null
          date_created: string
          date_last_updated: string
          id: number
          last_updated?: string | null
          ml_account_id: string
          organization_id: string
          pack_id?: number | null
          paid_amount?: number | null
          status: string
          status_detail?: string | null
          tags?: string[]
          total_amount: number
          updated_at?: string
        }
        Update: {
          buyer_id?: number | null
          cancel_reason?: string | null
          created_at?: string
          currency_id?: string
          date_closed?: string | null
          date_created?: string
          date_last_updated?: string
          id?: number
          last_updated?: string | null
          ml_account_id?: string
          organization_id?: string
          pack_id?: number | null
          paid_amount?: number | null
          status?: string
          status_detail?: string | null
          tags?: string[]
          total_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_organization_id_fkey"
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
          cnpj: string | null
          created_at: string
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          cnpj?: string | null
          created_at?: string
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          cnpj?: string | null
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
      purchase_order_events: {
        Row: {
          actor_user_id: string | null
          event_type: string
          id: string
          metadata: Json
          occurred_at: string
          organization_id: string
          purchase_order_id: string
        }
        Insert: {
          actor_user_id?: string | null
          event_type: string
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id: string
          purchase_order_id: string
        }
        Update: {
          actor_user_id?: string | null
          event_type?: string
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id?: string
          purchase_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_events_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_events_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_items: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          position: number
          purchase_order_id: string
          quantity_ordered: number
          sku_id: string | null
          sku_snapshot: string
          title_snapshot: string | null
          unit_cost: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          position: number
          purchase_order_id: string
          quantity_ordered: number
          sku_id?: string | null
          sku_snapshot: string
          title_snapshot?: string | null
          unit_cost?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          position?: number
          purchase_order_id?: string
          quantity_ordered?: number
          sku_id?: string | null
          sku_snapshot?: string
          title_snapshot?: string | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          created_by: string
          currency: string
          destination_warehouse_name: string | null
          expected_at: string | null
          id: string
          notes: string | null
          order_number: number
          ordered_at: string | null
          ordered_by: string | null
          organization_id: string
          received_at: string | null
          received_by: string | null
          status: string
          supplier_id: string | null
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          created_by: string
          currency?: string
          destination_warehouse_name?: string | null
          expected_at?: string | null
          id?: string
          notes?: string | null
          order_number?: never
          ordered_at?: string | null
          ordered_by?: string | null
          organization_id: string
          received_at?: string | null
          received_by?: string | null
          status?: string
          supplier_id?: string | null
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          created_by?: string
          currency?: string
          destination_warehouse_name?: string | null
          expected_at?: string | null
          id?: string
          notes?: string | null
          order_number?: never
          ordered_at?: string | null
          ordered_by?: string | null
          organization_id?: string
          received_at?: string | null
          received_by?: string | null
          status?: string
          supplier_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_ordered_by_fkey"
            columns: ["ordered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
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
      stock_movements: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          idempotency_key: string
          location_kind: string
          movement_type: string
          occurred_at: string
          organization_id: string
          qty_delta: number
          reason: string | null
          sku_id: string
          source_id: string | null
          source_type: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          idempotency_key: string
          location_kind: string
          movement_type: string
          occurred_at: string
          organization_id: string
          qty_delta: number
          reason?: string | null
          sku_id: string
          source_id?: string | null
          source_type?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          idempotency_key?: string
          location_kind?: string
          movement_type?: string
          occurred_at?: string
          organization_id?: string
          qty_delta?: number
          reason?: string | null
          sku_id?: string
          source_id?: string | null
          source_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          contact_name: string | null
          created_at: string
          created_by: string | null
          document: string | null
          email: string | null
          id: string
          is_active: boolean
          legal_name: string | null
          name: string
          notes: string | null
          organization_id: string
          phone: string | null
          updated_at: string
          website: string | null
          whatsapp: string | null
        }
        Insert: {
          contact_name?: string | null
          created_at?: string
          created_by?: string | null
          document?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          legal_name?: string | null
          name: string
          notes?: string | null
          organization_id: string
          phone?: string | null
          updated_at?: string
          website?: string | null
          whatsapp?: string | null
        }
        Update: {
          contact_name?: string | null
          created_at?: string
          created_by?: string | null
          document?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          legal_name?: string | null
          name?: string
          notes?: string | null
          organization_id?: string
          phone?: string | null
          updated_at?: string
          website?: string | null
          whatsapp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "suppliers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_errors: {
        Row: {
          created_at: string
          error_class: string
          id: string
          message: string
          ml_account_id: string
          occurred_at: string
          organization_id: string
          resource: string
          sync_run_id: string | null
        }
        Insert: {
          created_at?: string
          error_class: string
          id?: string
          message: string
          ml_account_id: string
          occurred_at: string
          organization_id: string
          resource: string
          sync_run_id?: string | null
        }
        Update: {
          created_at?: string
          error_class?: string
          id?: string
          message?: string
          ml_account_id?: string
          occurred_at?: string
          organization_id?: string
          resource?: string
          sync_run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_errors_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_errors_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_errors_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_runs: {
        Row: {
          channel: string
          created_at: string
          finished_at: string
          id: string
          items_processed: number | null
          job_id: string
          latest_record_at: string | null
          ml_account_id: string
          organization_id: string
          reason: string | null
          resource: string
          started_at: string
          status: string
        }
        Insert: {
          channel: string
          created_at?: string
          finished_at: string
          id?: string
          items_processed?: number | null
          job_id: string
          latest_record_at?: string | null
          ml_account_id: string
          organization_id: string
          reason?: string | null
          resource: string
          started_at: string
          status: string
        }
        Update: {
          channel?: string
          created_at?: string
          finished_at?: string
          id?: string
          items_processed?: number | null
          job_id?: string
          latest_record_at?: string | null
          ml_account_id?: string
          organization_id?: string
          reason?: string | null
          resource?: string
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_runs_ml_account_id_fkey"
            columns: ["ml_account_id"]
            isOneToOne: false
            referencedRelation: "ml_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_runs_organization_id_fkey"
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
      approve_purchase_order: {
        Args: { p_id: string }
        Returns: {
          approved_at: string | null
          approved_by: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          created_by: string
          currency: string
          destination_warehouse_name: string | null
          expected_at: string | null
          id: string
          notes: string | null
          order_number: number
          ordered_at: string | null
          ordered_by: string | null
          organization_id: string
          received_at: string | null
          received_by: string | null
          status: string
          supplier_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "purchase_orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cancel_purchase_order: {
        Args: { p_id: string; p_reason?: string }
        Returns: {
          approved_at: string | null
          approved_by: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          created_by: string
          currency: string
          destination_warehouse_name: string | null
          expected_at: string | null
          id: string
          notes: string | null
          order_number: number
          ordered_at: string | null
          ordered_by: string | null
          organization_id: string
          received_at: string | null
          received_by: string | null
          status: string
          supplier_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "purchase_orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      compute_erp_snapshot_balances: {
        Args: { p_organization_id: string }
        Returns: {
          location_kind: string
          quantity: number
          sku_id: string
        }[]
      }
      compute_inventory_balances_from_ledger: {
        Args: { p_organization_id: string; p_sku_id?: string }
        Returns: {
          location_kind: string
          quantity: number
          sku_id: string
        }[]
      }
      create_manual_stock_adjustment: {
        Args: {
          p_location_kind: string
          p_organization_id: string
          p_qty_delta: number
          p_reason: string
          p_sku_id: string
        }
        Returns: {
          created_at: string
          created_by: string | null
          id: string
          idempotency_key: string
          location_kind: string
          movement_type: string
          occurred_at: string
          organization_id: string
          qty_delta: number
          reason: string | null
          sku_id: string
          source_id: string | null
          source_type: string | null
        }
        SetofOptions: {
          from: "*"
          to: "stock_movements"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_purchase_order: {
        Args: {
          p_currency?: string
          p_destination_warehouse_name?: string
          p_expected_at?: string
          p_items: Json
          p_notes?: string
          p_organization_id: string
          p_supplier_id?: string
        }
        Returns: {
          approved_at: string | null
          approved_by: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          created_by: string
          currency: string
          destination_warehouse_name: string | null
          expected_at: string | null
          id: string
          notes: string | null
          order_number: number
          ordered_at: string | null
          ordered_by: string | null
          organization_id: string
          received_at: string | null
          received_by: string | null
          status: string
          supplier_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "purchase_orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_supplier: {
        Args: {
          p_contact_name?: string
          p_document?: string
          p_email?: string
          p_legal_name?: string
          p_name: string
          p_notes?: string
          p_organization_id: string
          p_phone?: string
          p_website?: string
          p_whatsapp?: string
        }
        Returns: {
          contact_name: string | null
          created_at: string
          created_by: string | null
          document: string | null
          email: string | null
          id: string
          is_active: boolean
          legal_name: string | null
          name: string
          notes: string | null
          organization_id: string
          phone: string | null
          updated_at: string
          website: string | null
          whatsapp: string | null
        }
        SetofOptions: {
          from: "*"
          to: "suppliers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      dismiss_link_candidate: {
        Args: { p_candidate_id: string }
        Returns: {
          channel_sku: string | null
          created_at: string
          id: string
          item_id: string | null
          ml_account_id: string
          organization_id: string
          ref_kind: string
          resolution_method: string | null
          resolved_at: string | null
          resolved_by: string | null
          resolved_sku_id: string | null
          sku_key: string
          source: string
          source_row_id: number
          status: string
          updated_at: string
          user_product_id: string | null
          variation_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "link_candidates"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_sales_daily_series: {
        Args: {
          p_date_from: string
          p_date_to: string
          p_ml_account_id?: string
        }
        Returns: {
          gross_revenue: number
          metric_date: string
          orders_count: number
          purchases_count: number
          units_sold: number
        }[]
      }
      get_sales_summary: {
        Args: {
          p_date_from: string
          p_date_to: string
          p_ml_account_id?: string
        }
        Returns: {
          average_selling_price: number
          average_ticket: number
          gross_revenue: number
          last_computed_at: string
          orders_count: number
          purchases_count: number
          units_sold: number
        }[]
      }
      link_document_item: {
        Args: { p_item_id: number; p_sku_id?: string }
        Returns: {
          cfop: string | null
          created_at: string
          description: string
          document_id: string
          ean: string | null
          id: number
          ncm: string | null
          position: number
          quantity: number
          sku_id: string | null
          supplier_code: string
          total_value: number
          unit: string
          unit_value: number
        }
        SetofOptions: {
          from: "*"
          to: "document_items"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      mark_purchase_order_ordered: {
        Args: { p_expected_at?: string; p_id: string }
        Returns: {
          approved_at: string | null
          approved_by: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          created_by: string
          currency: string
          destination_warehouse_name: string | null
          expected_at: string | null
          id: string
          notes: string | null
          order_number: number
          ordered_at: string | null
          ordered_by: string | null
          organization_id: string
          received_at: string | null
          received_by: string | null
          status: string
          supplier_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "purchase_orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      rebuild_daily_sales_metrics: {
        Args: {
          p_date_from: string
          p_date_to: string
          p_ml_account_id: string
          p_organization_id: string
        }
        Returns: number
      }
      receive_purchase_order: {
        Args: { p_id: string }
        Returns: {
          approved_at: string | null
          approved_by: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          created_by: string
          currency: string
          destination_warehouse_name: string | null
          expected_at: string | null
          id: string
          notes: string | null
          order_number: number
          ordered_at: string | null
          ordered_by: string | null
          organization_id: string
          received_at: string | null
          received_by: string | null
          status: string
          supplier_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "purchase_orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      recompute_daily_sales_metrics: {
        Args: {
          p_metric_date: string
          p_ml_account_id: string
          p_organization_id: string
        }
        Returns: number
      }
      resolve_link_candidate: {
        Args: { p_candidate_id: string; p_sku_id: string }
        Returns: {
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
        SetofOptions: {
          from: "*"
          to: "sku_listing_links"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_purchase_order_draft: {
        Args: {
          p_currency?: string
          p_destination_warehouse_name?: string
          p_expected_at?: string
          p_id: string
          p_items: Json
          p_notes?: string
          p_supplier_id?: string
        }
        Returns: {
          approved_at: string | null
          approved_by: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          created_by: string
          currency: string
          destination_warehouse_name: string | null
          expected_at: string | null
          id: string
          notes: string | null
          order_number: number
          ordered_at: string | null
          ordered_by: string | null
          organization_id: string
          received_at: string | null
          received_by: string | null
          status: string
          supplier_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "purchase_orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_supplier: {
        Args: {
          p_contact_name?: string
          p_document?: string
          p_email?: string
          p_id: string
          p_is_active?: boolean
          p_legal_name?: string
          p_name: string
          p_notes?: string
          p_phone?: string
          p_website?: string
          p_whatsapp?: string
        }
        Returns: {
          contact_name: string | null
          created_at: string
          created_by: string | null
          document: string | null
          email: string | null
          id: string
          is_active: boolean
          legal_name: string | null
          name: string
          notes: string | null
          organization_id: string
          phone: string | null
          updated_at: string
          website: string | null
          whatsapp: string | null
        }
        SetofOptions: {
          from: "*"
          to: "suppliers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
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
  public: {
    Enums: {},
  },
} as const
