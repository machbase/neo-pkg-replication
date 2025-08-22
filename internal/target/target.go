package target

type Target interface {
	Write([][]any) error
}

func New()
