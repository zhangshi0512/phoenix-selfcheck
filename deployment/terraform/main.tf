# Terraform Configuration for SelfCheck
# Phase 1: Cloud Functions deployment

terraform {
  required_version = ">= 1.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
  backend "gcs" {
    bucket = "selfcheck-terraform-state"
    prefix = "terraform/state"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "services" {
  for_each = toset([
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "logging.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "eventarc.googleapis.com",
    "firestore.googleapis.com",
    "monitoring.googleapis.com",
    "run.googleapis.com",
    "translate.googleapis.com"
  ])
  
  service = each.value
  disable_on_destroy = false
}

# Service account for Cloud Function
resource "google_service_account" "selfcheck_function" {
  account_id   = "selfcheck-function-sa"
  display_name = "SelfCheck Cloud Function Service Account"
  
  depends_on = [google_project_service.services["iam.googleapis.com"]]
}

# IAM bindings
resource "google_project_iam_member" "function_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.selfcheck_function.email}"
}

resource "google_project_iam_member" "function_secret_access" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.selfcheck_function.email}"
}

resource "google_project_iam_member" "function_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.selfcheck_function.email}"
}

resource "google_project_iam_member" "function_monitoring" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.selfcheck_function.email}"
}

# Secret Manager - Arize API Key
resource "google_secret_manager_secret" "arize_api_key" {
  secret_id = "arize-api-key"
  
  replication {
    automatic = true
  }
  
  depends_on = [google_project_service.services["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_version" "arize_api_key_version" {
  secret      = google_secret_manager_secret.arize_api_key.id
  secret_data = var.arize_api_key
}

# Secret Manager - Gemini API Key
resource "google_secret_manager_secret" "gemini_api_key" {
  secret_id = "gemini-api-key"

  replication {
    automatic = true
  }

  depends_on = [google_project_service.services["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_version" "gemini_api_key_version" {
  secret      = google_secret_manager_secret.gemini_api_key.id
  secret_data = var.gemini_api_key
}

# Secret Manager - Agent Webhook Key
resource "google_secret_manager_secret" "webhook_key" {
  secret_id = "webhook-api-key"
  
  replication {
    automatic = true
  }
}

resource "google_secret_manager_secret_version" "webhook_key_version" {
  secret      = google_secret_manager_secret.webhook_key.id
  secret_data = var.webhook_api_key
}

# Cloud Function (Gen2)
resource "google_cloudfunctions2_function" "selfcheck_webhook" {
  name        = "selfcheck-webhook"
  description = "SelfCheck Agent Webhook Handler"
  location    = var.region

  build_config {
    runtime     = "nodejs20"
    entry_point = "webhook"
    source {
      storage_source {
        bucket = google_storage_bucket.function_source.name
        object = google_storage_bucket_object.function_source_zip.name
      }
    }
  }

  service_config {
    max_instance_count = 10
    min_instance_count = 0
    available_memory   = "512M"
    timeout_seconds    = 120
    service_account_email = google_service_account.selfcheck_function.email

    environment_variables = {
      ARIZE_ENDPOINT       = var.arize_endpoint
      ARIZE_PROJECT_ID     = var.arize_project_id
      NODE_ENV             = "production"
      GOOGLE_CLOUD_PROJECT = var.project_id
    }

    secret_environment_variables {
      key     = "ARIZE_API_KEY"
      secret  = google_secret_manager_secret.arize_api_key.secret_id
      version = "latest"
    }

    secret_environment_variables {
      key     = "WEBHOOK_API_KEY"
      secret  = google_secret_manager_secret.webhook_key.secret_id
      version = "latest"
    }

    secret_environment_variables {
      key     = "GEMINI_API_KEY"
      secret  = google_secret_manager_secret.gemini_api_key.secret_id
      version = "latest"
    }

    secret_environment_variables {
      key     = "GOOGLE_API_KEY"
      secret  = google_secret_manager_secret.gemini_api_key.secret_id
      version = "latest"
    }
  }

  depends_on = [
    google_project_service.services["cloudfunctions.googleapis.com"],
    google_project_iam_member.function_logging,
    google_project_iam_member.function_firestore,
    google_project_iam_member.function_monitoring
  ]
}

# Storage bucket for function source code
resource "google_storage_bucket" "function_source" {
  name     = "${var.project_id}-selfcheck-function-source"
  location = var.region
  
  uniform_bucket_level_access = true
  force_destroy               = true
  
  depends_on = [google_project_service.services["storage.googleapis.com"]]
}

resource "google_storage_bucket_object" "function_source_zip" {
  name   = "selfcheck-webhook-${formatdate("YYYYMMDDhhmmss", timestamp())}.zip"
  bucket = google_storage_bucket.function_source.name
  source = data.archive_file.function_zip.output_path
  
  depends_on = [google_storage_bucket.function_source]
}

# Archive function source code (project root, since package.json is there)
data "archive_file" "function_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../.."
  output_path = "${path.module}/function.zip"
  excludes = [
    ".env",
    ".git/**",
    ".terraform-build/**",
    "coverage/**",
    "deployment/terraform/.terraform/**",
    "deployment/terraform/function.zip",
    "node_modules/**"
  ]
}

# IAM for public access (Gen2)
resource "google_cloudfunctions2_function_iam_member" "invoker" {
  project        = google_cloudfunctions2_function.selfcheck_webhook.project
  location       = google_cloudfunctions2_function.selfcheck_webhook.location
  cloud_function = google_cloudfunctions2_function.selfcheck_webhook.name

  role   = "roles/cloudfunctions.invoker"
  member = "allUsers"
}

# Outputs
output "function_url" {
  value = google_cloudfunctions2_function.selfcheck_webhook.service_config[0].uri
}

output "service_account_email" {
  value = google_service_account.selfcheck_function.email
}
