package source

import (
	"fmt"
	"repli/config"
	"repli/internal/ports"
	"strings"
)

func Build(specs ...config.SourceSpec) (map[string]ports.Source, error) {
	out := make(map[string]ports.Source, len(specs))

	for _, spec := range specs {
		var impl ports.Source

		switch strings.ToLower(spec.Type) {
		case "machbase":
			impl = newMachbase(spec)
		default:
			return nil, fmt.Errorf("unknown source type: %q", spec.Type)
		}

		if _, dup := out[spec.Name]; dup {
			return nil, fmt.Errorf("duplicate source name: %q", spec.Name)
		}

		out[spec.Name] = impl
	}

	return out, nil
}
