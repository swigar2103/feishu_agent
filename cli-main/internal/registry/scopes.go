// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

package registry

import (
	"sort"
	"strings"
)

// IdentityToAccessToken maps the --identity flag value to the corresponding
// accessTokens value used in from_meta JSON files. Bot identity uses
// tenant_access_token, so "bot" maps to "tenant".
func IdentityToAccessToken(identity string) string {
	if identity == "bot" {
		return "tenant"
	}
	return identity
}

// FilterScopes filters scopes by domain and permission level.
func FilterScopes(allScopes []string, domains []string, permissions []string) []string {
	var result []string
	for _, scope := range allScopes {
		parts := strings.Split(scope, ":")

		if len(domains) > 0 {
			if len(parts) == 0 {
				continue
			}
			found := false
			for _, d := range domains {
				if parts[0] == d {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}

		if len(permissions) > 0 {
			if len(parts) < 3 {
				continue
			}
			perm := parts[2]
			matched := false
			for _, p := range permissions {
				switch p {
				case "read":
					if strings.Contains(perm, "read") {
						matched = true
					}
				case "write":
					if strings.Contains(perm, "write") {
						matched = true
					}
				case "readonly":
					if perm == "readonly" {
						matched = true
					}
				case "writeonly":
					if perm == "writeonly" || perm == "write_only" {
						matched = true
					}
				}
			}
			if !matched {
				continue
			}
		}

		result = append(result, scope)
	}
	return result
}

// CollectScopesForProjects collects the recommended scope for each API method
// in the specified from_meta projects. For each method, only the scope with
// the highest priority score is selected.
func CollectScopesForProjects(projects []string, identity string) []string {
	priorities := LoadScopePriorities()
	scopeSet := make(map[string]bool)
	for _, project := range projects {
		spec := LoadFromMeta(project)
		if spec == nil {
			continue
		}
		resources, ok := spec["resources"].(map[string]interface{})
		if !ok {
			continue
		}
		for _, resSpec := range resources {
			resMap, ok := resSpec.(map[string]interface{})
			if !ok {
				continue
			}
			methods, ok := resMap["methods"].(map[string]interface{})
			if !ok {
				continue
			}
			for _, methodSpec := range methods {
				methodMap, ok := methodSpec.(map[string]interface{})
				if !ok {
					continue
				}
				if tokens, ok := methodMap["accessTokens"].([]interface{}); ok {
					supported := false
					for _, t := range tokens {
						if ts, ok := t.(string); ok && ts == IdentityToAccessToken(identity) {
							supported = true
							break
						}
					}
					if !supported {
						continue
					}
				}
				scopes, ok := methodMap["scopes"].([]interface{})
				if !ok || len(scopes) == 0 {
					continue
				}
				bestScope := ""
				bestScore := -1
				for _, s := range scopes {
					str, ok := s.(string)
					if !ok {
						continue
					}
					score := DefaultScopeScore
					if v, exists := priorities[str]; exists {
						score = v
					}
					if score > bestScore {
						bestScore = score
						bestScope = str
					}
				}
				if bestScope != "" {
					scopeSet[bestScope] = true
				}
			}
		}
	}

	result := make([]string, 0, len(scopeSet))
	for s := range scopeSet {
		result = append(result, s)
	}
	sort.Strings(result)
	return result
}

// ScopeSource tracks which APIs and shortcuts contributed a scope.
type ScopeSource struct {
	APIs      []string // e.g. "POST calendar.event.create"
	Shortcuts []string // e.g. "+send", "+reply"
}

// CollectScopesWithSources is like CollectScopesForProjects but also records
// which API method contributed each scope. Used by scope-audit.
func CollectScopesWithSources(projects []string, identity string) ([]string, map[string]*ScopeSource) {
	priorities := LoadScopePriorities()
	scopeSet := make(map[string]bool)
	sources := make(map[string]*ScopeSource)

	for _, project := range projects {
		spec := LoadFromMeta(project)
		if spec == nil {
			continue
		}
		resources, ok := spec["resources"].(map[string]interface{})
		if !ok {
			continue
		}
		for resName, resSpec := range resources {
			resMap, ok := resSpec.(map[string]interface{})
			if !ok {
				continue
			}
			methods, ok := resMap["methods"].(map[string]interface{})
			if !ok {
				continue
			}
			for methodName, methodSpec := range methods {
				methodMap, ok := methodSpec.(map[string]interface{})
				if !ok {
					continue
				}
				if tokens, ok := methodMap["accessTokens"].([]interface{}); ok {
					supported := false
					for _, t := range tokens {
						if ts, ok := t.(string); ok && ts == IdentityToAccessToken(identity) {
							supported = true
							break
						}
					}
					if !supported {
						continue
					}
				}
				scopes, ok := methodMap["scopes"].([]interface{})
				if !ok || len(scopes) == 0 {
					continue
				}
				bestScope := ""
				bestScore := -1
				for _, s := range scopes {
					str, ok := s.(string)
					if !ok {
						continue
					}
					score := DefaultScopeScore
					if v, exists := priorities[str]; exists {
						score = v
					}
					if score > bestScore {
						bestScore = score
						bestScope = str
					}
				}
				if bestScope != "" {
					scopeSet[bestScope] = true
					if sources[bestScope] == nil {
						sources[bestScope] = &ScopeSource{}
					}
					methodID := GetStrFromMap(methodMap, "id")
					if methodID == "" {
						methodID = project + "." + resName + "." + methodName
					}
					httpMethod := GetStrFromMap(methodMap, "httpMethod")
					if httpMethod == "" {
						httpMethod = "?"
					}
					sources[bestScope].APIs = append(sources[bestScope].APIs, httpMethod+" "+methodID)
				}
			}
		}
	}

	// Sort API lists for stable output
	for _, src := range sources {
		sort.Strings(src.APIs)
	}

	result := make([]string, 0, len(scopeSet))
	for s := range scopeSet {
		result = append(result, s)
	}
	sort.Strings(result)
	return result, sources
}

// CommandEntry represents a CLI command (API method or shortcut) and its scopes.
type CommandEntry struct {
	Command    string   // CLI label, e.g. "calendars create" or "+agenda"
	Type       string   // "api" or "shortcut"
	Scopes     []string // effective scopes (requiredScopes if present, else [bestScope])
	HTTPMethod string   // e.g. "POST" (API only)
}

// CollectCommandScopes walks from_meta methods for the given projects and
// returns one CommandEntry per API method, sorted by command label.
//
// Scope selection per method:
//   - If the method has a "requiredScopes" field, all of those scopes are needed (conjunction).
//   - Otherwise, only the highest-priority scope from "scopes" is shown (minimum privilege).
func CollectCommandScopes(projects []string, identity string) []CommandEntry {
	priorities := LoadScopePriorities()
	var entries []CommandEntry

	for _, project := range projects {
		spec := LoadFromMeta(project)
		if spec == nil {
			continue
		}
		resources, ok := spec["resources"].(map[string]interface{})
		if !ok {
			continue
		}
		for resName, resSpec := range resources {
			resMap, ok := resSpec.(map[string]interface{})
			if !ok {
				continue
			}
			methods, ok := resMap["methods"].(map[string]interface{})
			if !ok {
				continue
			}
			for methodName, methodSpec := range methods {
				methodMap, ok := methodSpec.(map[string]interface{})
				if !ok {
					continue
				}
				if tokens, ok := methodMap["accessTokens"].([]interface{}); ok {
					supported := false
					for _, t := range tokens {
						if ts, ok := t.(string); ok && ts == IdentityToAccessToken(identity) {
							supported = true
							break
						}
					}
					if !supported {
						continue
					}
				}
				rawScopes, ok := methodMap["scopes"].([]interface{})
				if !ok || len(rawScopes) == 0 {
					continue
				}

				// Check for requiredScopes (conjunction — all needed)
				var effectiveScopes []string
				if reqRaw, ok := methodMap["requiredScopes"].([]interface{}); ok && len(reqRaw) > 0 {
					for _, s := range reqRaw {
						if str, ok := s.(string); ok {
							effectiveScopes = append(effectiveScopes, str)
						}
					}
				} else {
					// Pick the single best scope (minimum privilege)
					bestScope := ""
					bestScore := -1
					for _, s := range rawScopes {
						str, ok := s.(string)
						if !ok {
							continue
						}
						score := DefaultScopeScore
						if v, exists := priorities[str]; exists {
							score = v
						}
						if score > bestScore {
							bestScore = score
							bestScope = str
						}
					}
					if bestScope != "" {
						effectiveScopes = []string{bestScope}
					}
				}
				if len(effectiveScopes) == 0 {
					continue
				}

				httpMethod := GetStrFromMap(methodMap, "httpMethod")
				entries = append(entries, CommandEntry{
					Command:    resName + " " + methodName,
					Type:       "api",
					Scopes:     effectiveScopes,
					HTTPMethod: httpMethod,
				})
			}
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Command < entries[j].Command
	})
	return entries
}

// GetScopesForDomains returns scopes for specific projects (by project name).
func GetScopesForDomains(projects []string, identity string) []string {
	return CollectScopesForProjects(projects, identity)
}

// GetReadOnlyScopes returns read-only scopes from the recommended (best-per-method) scope set.
func GetReadOnlyScopes(identity string) []string {
	allProjects := ListFromMetaProjects()
	return FilterScopes(CollectScopesForProjects(allProjects, identity), nil, []string{"read", "readonly"})
}

// ResolveScopesFromFilters resolves scopes from project and permission filters.
func ResolveScopesFromFilters(projects []string, permissions []string, identity string) []string {
	return FilterScopes(CollectScopesForProjects(projects, identity), nil, permissions)
}

// ComputeMinimumScopeSet computes the minimum set of scopes that covers all
// from_meta API methods. Equivalent to CollectScopesForProjects with all projects.
func ComputeMinimumScopeSet(identity string) []string {
	return CollectScopesForProjects(ListFromMetaProjects(), identity)
}
