export type IOpenApiSpec = Record<"openapi", string> & Record<string, any>;

type OpenApiSchemaType = "string" | "integer" | "number" | "array" | "object" | "boolean" | "null";

export type IOpenApSchemaSpec = {
  nullable?: boolean;
  type?: OpenApiSchemaType | OpenApiSchemaType[];
  example?: any;
  enum?: string[];
  format?: string;
  items?: IOpenApSchemaSpec;
  required?: string[];
  $ref?: string;
  properties?: Record<string, IOpenApSchemaSpec>;
  additionalProperties?: IOpenApSchemaSpec;
  anyOf?: IOpenApSchemaSpec[];
  oneOf?: IOpenApSchemaSpec[];
  allOf?: IOpenApSchemaSpec[];
};

export type IOpenApiParameterSpec = {
  $ref?: string;
  name: string;
  in: string;
  enum?: string[];
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  allowEmptyValue?: boolean;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  schema?: IOpenApSchemaSpec;
  example?: any;
  examples?: any[];
};

export type IOpenApiMediaTypeSpec = {
  schema?: IOpenApSchemaSpec;
  example?: any;
  examples?: any[];
  encoding?: any;
};

export type IOpenApiRequestBodySpec = {
  description?: string;
  required?: boolean;
  content: Record<string, IOpenApiMediaTypeSpec>;
  $ref: string;
};

export type IOpenApiResponseSpec = Record<string, IOpenApiRequestBodySpec>;

export type IConfigReplaceWord = {
  /**  string and regular expression as a string*/
  replace: string;
  with: string;
  type?: "endpoint" | "type";
};
