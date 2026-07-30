// Package jsonschemaregexp adapts regexp2 to the JSON Schema compiler's regexp
// interface. JSON Schema specifies ECMAScript regular expressions, which permit
// lookarounds that Go's RE2 engine rejects at compile time, so every schema
// compiler in this repository shares this one engine instead of restating it.
package jsonschemaregexp

import (
	"github.com/dlclark/regexp2"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type ecmaScriptRegexp regexp2.Regexp

func (expression *ecmaScriptRegexp) MatchString(value string) bool {
	matched, err := (*regexp2.Regexp)(expression).MatchString(value)
	return err == nil && matched
}

func (expression *ecmaScriptRegexp) String() string {
	return (*regexp2.Regexp)(expression).String()
}

// Compile is a jsonschema.RegexpEngine that reads patterns as ECMAScript.
func Compile(expression string) (jsonschema.Regexp, error) {
	compiled, err := regexp2.Compile(expression, regexp2.ECMAScript)
	if err != nil {
		return nil, err
	}
	return (*ecmaScriptRegexp)(compiled), nil
}
