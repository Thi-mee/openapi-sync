import { IOpenApiSpec, IOpenApSchemaSpec } from "../types";
import { variableNameChar } from "./regex";
import * as yaml from "js-yaml";
import lodash from "lodash";

export const isJson = (value: any): value is object => {
  return typeof value === "object" && value !== null && !(value instanceof Blob);
};

export const isYamlString = (fileContent: string) => {
  try {
    yaml.load(fileContent);
    return true;
  } catch (err: unknown) {
    console.warn('YAML parsing failed:', err);
    if (err instanceof yaml.YAMLException) {
      return false;
    } 
    throw err;
  }
};

export const yamlStringToJson = (fileContent: string) => {
  if (isYamlString(fileContent)) {
    const content = yaml.load(fileContent);

    const jsonString = JSON.stringify(content, null, 2);
    const json = JSON.parse(jsonString);
    return json;
  }
};

export const capitalize = (text: string) => {
  const capitalizedWord =
    text.substring(0, 1).toUpperCase() + text.substring(1);
  return capitalizedWord;
};

export const getSharedComponentName = (
  componentName: string,
  componentType?:
    | "parameters"
    | "responses"
    | "schemas"
    | "requestBodies"
    | "headers"
    | "links"
    | "callbacks"
) => `IApi${capitalize(componentName)}`;

export const getEndpointDetails = (path: string, method: string) => {
  const pathParts = path.split("/");
  let name = `${capitalize(method)}`;
  const variables: string[] = [];
  pathParts.forEach((part) => {
    // check if part is a variable
    //api/{userId}
    if (part[0] === "{" && part[part.length - 1] === "}") {
      const s = part.replace(/{/, "").replace(/}/, "");
      variables.push(s);
      part = `$${s}`;
    }

    //api/<userId>
    else if (part[0] === "<" && part[part.length - 1] === ">") {
      const s = part.replace(/</, "").replace(/>/, "");
      variables.push(s);
      part = `$${s}`;
    }

    //api/:userId
    else if (part[0] === ":") {
      const s = part.replace(/:/, "");
      variables.push(s);
      part = `$${s}`;
    }

    // parse to variable name
    let partVal = "";
    part.split("").forEach((char) => {
      let c = char;
      if (!variableNameChar.test(char)) c = "/";
      partVal += c;
    });

    partVal.split("/").forEach((val) => {
      name += capitalize(val);
    });
  });

  return { name, variables, pathParts };
};

const handleRef = (
  apiDoc: IOpenApiSpec,
  schema: IOpenApSchemaSpec,
  options?: { noSharedImport?: boolean }
): { type: string; componentName: string; overrideName: string } => {
  let type = "";
  let componentName = "";
  let overrideName = "";

  if (schema.$ref && schema.$ref.startsWith("#")) {
    const pathToComponentParts = schema.$ref.split("/").slice(1);
    const pathToComponent = pathToComponentParts.join(".");
    const component = lodash.get(apiDoc, pathToComponent, null) as IOpenApSchemaSpec;

    if (component) {
      if ('name' in component && typeof component.name === 'string') {
        overrideName = component.name;
      }
      componentName = pathToComponentParts[pathToComponentParts.length - 1];
      type = `${options?.noSharedImport ? "" : "Shared."}${getSharedComponentName(
        componentName
      )}`;
    }
  }
  // TODO: Handle external $ref (URI)
  return { type, componentName, overrideName };
};

const handleComposition = (
  apiDoc: IOpenApiSpec,
  schemas: IOpenApSchemaSpec[],
  separator: "|" | "&",
  options?: any
): string => {
  return `(${schemas
    .map((v) => parseSchemaToType(apiDoc, v, "", false, options))
    .join(separator)})`;
};

const handleProperties = (
  apiDoc: IOpenApiSpec,
  schema: IOpenApSchemaSpec,
  options?: any
): string => {
  if (!schema.properties) {
    return "{[k: string]: any}";
  }
  const objKeys = Object.keys(schema.properties);
  const requiredKeys = schema.required || [];
  let typeCnt = "";

  objKeys.forEach((key) => {
    typeCnt += parseSchemaToType(
      apiDoc,
      schema.properties?.[key] as IOpenApSchemaSpec,
      key,
      requiredKeys.includes(key),
      options
    );
  });

  return typeCnt.length > 0 ? `{\n${typeCnt}}` : "{[k: string]: any}";
};

const handleType = (
  apiDoc: IOpenApiSpec,
  schema: IOpenApSchemaSpec,
  options?: any
): string => {
  if (Array.isArray(schema.type)) {
    const types = schema.type
      .filter((t) => t !== "null")
      .map((t) => handleType(apiDoc, { ...schema, type: t }, options));
    return `(${types.join(" | ")})`;
  }

  // if(schema.format === 'uuid') {
  //   logFive(schema);
  //   return 'string';
  // }

  switch (schema.type) {
    case "integer":
    case "number":
      return "number";
    case "array":
      if (schema.items) {
        return `${parseSchemaToType(apiDoc, schema.items, "", false, options)}[]`;
      }
      return "any[]";
    case "object":
      if (schema.properties) {
        const objKeys = Object.keys(schema.properties);
        const requiredKeys = schema.required || [];
        let typeCnt = "";

        objKeys.forEach((key) => {
          typeCnt += parseSchemaToType(
            apiDoc,
            schema.properties?.[key] as IOpenApSchemaSpec,
            key,
            requiredKeys.includes(key),
            options
          );
        });

        return typeCnt.length > 0 ? `{\n${typeCnt}}` : "{[k: string]: any}";
      }
      if (schema.additionalProperties) {
        return `{[k: string]: ${
          parseSchemaToType(apiDoc, schema.additionalProperties, "", true, options) || "any"
        }}`;
      }
      return "{[k: string]: any}";
    default:
      return schema.type || "string";
  }
};

// Helper function to clean type content for shared components
export const cleanTypeContent = (typeContent: string): string => {
  // Remove property syntax like '\t"propertyName"?: ' from the beginning
  const propertyPattern = /^\s*"[^"]+"\??\s*:\s*/;
  const cleaned = typeContent.replace(propertyPattern, '');
  
  // Remove trailing semicolon and newline
  return cleaned.replace(/;\s*\n?\s*$/, '').trim();
};

// export const validateTypeContent = (content: string): boolean => {
//   // Check for common syntax errors
//   const invalidPatterns = [
//     /:\s*;/, // Empty type after colon
//     /^[^=]*=\s*;/, // Empty type assignment  
//     /"\w+"\s*:\s*IApi\w+;/, // Property syntax in type alias
//     /=\s*\t"/, // Tab after equals in type alias
//   ];
  
//   return !invalidPatterns.some(pattern => pattern.test(content));
// };

// Enhanced validation function with detailed error reporting
interface ValidationError {
  line: number;
  content: string;
  error: string;
  suggestion?: string;
}

const validateTypeDefinition = (typeDefinition: string, lineNumber: number, fullLine: string, errors: ValidationError[]) => {
  const trimmedDef = typeDefinition.trim();
  
  // Check for empty type definition
  if (!trimmedDef || trimmedDef === ';') {
    errors.push({
      line: lineNumber,
      content: fullLine,
      error: 'Empty type definition',
      suggestion: 'Provide a valid type (e.g., string, number, object type)'
    });
    return;
  }
  
  // Check for malformed object types with property syntax
  if (trimmedDef.includes('"\w+"\s*:') && !trimmedDef.startsWith('{')) {
    errors.push({
      line: lineNumber,
      content: fullLine,
      error: 'Property syntax found outside object type',
      suggestion: 'Wrap properties in braces: { "prop": type }'
    });
  }
  
  // Check for invalid characters at the beginning
  if (/^\s*["']/.test(trimmedDef) && !trimmedDef.startsWith('{')) {
    errors.push({
      line: lineNumber,
      content: fullLine,
      error: 'Type definition starts with quote but is not an object or string literal type',
      suggestion: 'Check if this should be a string literal type or object type'
    });
  }
  
  // Check for semicolon in the middle (common error from property syntax)
  if (/;\s*[^}]/.test(trimmedDef)) {
    errors.push({
      line: lineNumber,
      content: fullLine,
      error: 'Semicolon found in middle of type definition',
      suggestion: 'Remove semicolon or fix type structure'
    });
  }
  
  // Check for common malformed patterns from your examples
  if (/"\w+"\s*:\s*IApi\w+\s*;/.test(trimmedDef)) {
    errors.push({
      line: lineNumber,
      content: fullLine,
      error: 'Property syntax used in type alias',
      suggestion: 'This should be just the type name: IApiTypeName'
    });
  }
  
  // Check for the specific UUID pattern error from your example
  if (/"\w+"\s*:\s*IApi\w+\s*;\s*$/.test(trimmedDef)) {
    errors.push({
      line: lineNumber,
      content: fullLine,
      error: 'Malformed type definition with property syntax',
      suggestion: 'Should be just: IApiUUID (not "UUID": IApiUUID;)'
    });
  }
};

export const validateTypeContent = (content: string): { isValid: boolean; errors: ValidationError[] } => {
  const lines = content.split('\n');
  const errors: ValidationError[] = [];
  
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmedLine = line.trim();
    
    // Skip empty lines and comments
    if (!trimmedLine || trimmedLine.startsWith('//')) return;
    
    // Check for export type declarations
    if (trimmedLine.startsWith('export type ')) {
      // Pattern: export type TypeName = TypeDefinition;
      const typeDeclarationPattern = /^export type\s+(\w+)\s*=\s*(.+);?\s*$/;
      const match = trimmedLine.match(typeDeclarationPattern);
      
      if (!match) {
        errors.push({
          line: lineNumber,
          content: trimmedLine,
          error: 'Invalid export type declaration syntax',
          suggestion: 'Should be: export type TypeName = TypeDefinition;'
        });
        return;
      }
      
      const [, typeName, typeDefinition] = match;
      
      // Check type name follows convention
      if (!typeName.startsWith('IApi')) {
        errors.push({
          line: lineNumber,
          content: trimmedLine,
          error: `Type name "${typeName}" should start with "IApi"`,
          suggestion: `Use "IApi${typeName}" instead`
        });
      }
      
      // Check for common type definition issues
      validateTypeDefinition(typeDefinition, lineNumber, trimmedLine, errors);
    }
    
    // Check for property syntax in type aliases (this shouldn't happen)
    if (trimmedLine.includes('export type') && /"\w+"\s*\??\s*:\s*/.test(trimmedLine)) {
      errors.push({
        line: lineNumber,
        content: trimmedLine,
        error: 'Property syntax found in type alias',
        suggestion: 'Type aliases should not contain property definitions'
      });
    }
    
    // Check for malformed object syntax
    if (trimmedLine.includes('=') && /=\s*\t"/.test(trimmedLine)) {
      errors.push({
        line: lineNumber,
        content: trimmedLine,
        error: 'Tab character found after equals sign',
        suggestion: 'Remove tab character and fix formatting'
      });
    }
    
    // Check for empty type assignments
    if (/=\s*;/.test(trimmedLine)) {
      errors.push({
        line: lineNumber,
        content: trimmedLine,
        error: 'Empty type assignment',
        suggestion: 'Provide a valid type definition'
      });
    }
    
    // Check for unclosed braces
    const openBraces = (trimmedLine.match(/{/g) || []).length;
    const closeBraces = (trimmedLine.match(/}/g) || []).length;
    if (openBraces !== closeBraces && !trimmedLine.endsWith(';')) {
      errors.push({
        line: lineNumber,
        content: trimmedLine,
        error: 'Mismatched braces',
        suggestion: 'Check opening and closing braces'
      });
    }
  });
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

export const logValidationErrors = (errors: ValidationError[], filename: string = 'shared.ts') => {
  console.error(`\n❌ TypeScript syntax errors found in ${filename}:`);
  console.error('=' .repeat(60));
  
  errors.forEach((error, index) => {
    console.error(`\n${index + 1}. Line ${error.line}:`);
    console.error(`   Content: ${error.content}`);
    console.error(`   Error: ${error.error}`);
    if (error.suggestion) {
      console.error(`   Suggestion: ${error.suggestion}`);
    }
  });
  
  console.error('\n' + '='.repeat(60));
  console.error(`Total errors: ${errors.length}`);
};

export const parseSchemaToType = (
  apiDoc: IOpenApiSpec,
  schema: IOpenApSchemaSpec,
  name: string,
  isRequired?: boolean,
  options?: {
    noSharedImport?: boolean;
    useComponentName?: boolean;
    maxDepth?: number;
    currentDepth?: number;
  }
): string => {
  if (!schema) {
    return name ? `\t"${name}"${isRequired ? "" : "?"}: string;\n` : "string";
  }

  // Add recursion depth protection
  const maxDepth = options?.maxDepth ?? 10;
  const currentDepth = options?.currentDepth ?? 0;
  
  if (currentDepth >= maxDepth) {
    console.warn(`Maximum recursion depth reached for schema: ${name}`);
    return 'any';
  }
  
  const nextOptions = { ...options, currentDepth: currentDepth + 1 };

  let type = "";
  let componentName = "";
  let overrideName = "";

  if (schema.$ref) {
    if (schema.$ref.startsWith("#")) {
      const pathToComponentParts = schema.$ref.split("/").slice(1);
      const pathToComponent = pathToComponentParts.join(".");
      const component = lodash.get(apiDoc, pathToComponent, null) as IOpenApSchemaSpec | null;

      if (component) {
        // Type guard for name property
        if ('name' in component && typeof component.name === 'string') {
          overrideName = component.name;
        }
        componentName = pathToComponentParts[pathToComponentParts.length - 1];
        type = `${options?.noSharedImport ? "" : "Shared."}${getSharedComponentName(
          componentName
        )}`;
      }
    }
    // TODO: Handle external $ref (URI)
  } else if (schema.anyOf) {
    type = `(${schema.anyOf
      .map((v) => parseSchemaToType(apiDoc, v, "", false, nextOptions))
      .join(" | ")})`;
  } else if (schema.oneOf) {
    type = `(${schema.oneOf
      .map((v) => parseSchemaToType(apiDoc, v, "", false, nextOptions))
      .join(" | ")})`;
  } else if (schema.allOf) {
    type = `(${schema.allOf
      .map((v) => parseSchemaToType(apiDoc, v, "", false, nextOptions))
      .join(" & ")})`;
  } else if (schema.enum) {
    type = `(${schema.enum.map((v) => `"${v}"`).join(" | ")})`;
  } else {
    type = handleType(apiDoc, schema, nextOptions);
  }

  const finalName = overrideName || name || (options?.useComponentName ? componentName : "");
  
  // For shared components (when no name is provided), return just the type
  if (!name && !overrideName) {
    const nullable = Array.isArray(schema.type) && schema.type.includes("null") ? " | null" : "";
    return type ? `${type}${nullable}` : "";
  }

  // For properties, use the property syntax
  const typeName = finalName ? `\t"${finalName}"${isRequired ? "" : "?"}: ` : "";
  const nullable = Array.isArray(schema.type) && schema.type.includes("null") ? " | null" : "";

  return type ? `${typeName}${type}${nullable}${finalName ? ";\n" : ""}` : "";
};