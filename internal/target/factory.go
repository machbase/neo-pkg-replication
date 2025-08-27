package target

import (
	"fmt"
	"repli/config"
	"repli/internal/ports"
	"strings"
)

func Build(specs ...config.TargetSpec) (map[string]ports.Target, error) {
	out := make(map[string]ports.Target, len(specs))

	for _, spec := range specs {
		var impl ports.Target

		switch strings.ToLower(spec.Type) {
		case "machbase":
			impl = newMachbase(spec)
		default:
			return nil, fmt.Errorf("unknown target type: %q", spec.Type)
		}

		if _, dup := out[spec.Name]; dup {
			return nil, fmt.Errorf("duplicate target name: %q", spec.Name)
		}

		out[spec.Name] = impl
	}

	return out, nil
}
