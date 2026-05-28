# Terraform Variables for SelfCheck

variable "project_id" {
  description = "Google Cloud Project ID"
  type        = string
  default     = "selfcheck-hackathon"
}

variable "region" {
  description = "Google Cloud Region"
  type        = string
  default     = "us-central1"
}

variable "arize_project_id" {
  description = "Arize Phoenix Project ID"
  type        = string
  sensitive   = true
}

variable "arize_api_key" {
  description = "Arize Phoenix API Key"
  type        = string
  sensitive   = true
}

variable "arize_endpoint" {
  description = "Arize Phoenix OTLP/API endpoint"
  type        = string
  default     = "https://app.phoenix.arize.com"
}

variable "gemini_api_key" {
  description = "Gemini API key used by the LLM-as-judge and prompt improvement loop"
  type        = string
  sensitive   = true
}

variable "webhook_api_key" {
  description = "API Key for webhook authentication"
  type        = string
  sensitive   = true
  default     = ""
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "development"
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "Environment must be development, staging, or production."
  }
}
