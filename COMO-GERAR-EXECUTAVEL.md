# Como Gerar o Executável (.exe) do Link Eats Printer

Este guia mostra como gerar um executável standalone do aplicativo para distribuição.

## 📋 Pré-requisitos

Antes de gerar o executável, certifique-se de ter instalado:

1. **Node.js 16+** - [Download aqui](https://nodejs.org/)
2. **Python 3.7+** - [Download aqui](https://www.python.org/downloads/)
   - ⚠️ Durante a instalação do Python, marque a opção "Add Python to PATH"

## 🚀 Método Rápido (Recomendado)

### Opção 1: Script Automático

1. Abra o terminal/prompt na pasta do projeto
2. Execute o script de build:
   ```bash
   build-standalone.bat
   ```

Este script irá:
- ✅ Verificar todas as dependências
- ✅ Instalar pacotes necessários
- ✅ Compilar o motor de impressão Python
- ✅ Gerar o executável portátil do Electron
- ✅ Criar também um instalador NSIS (opcional)

### Resultado

Após a conclusão, você encontrará na pasta `dist/`:

- **Link-Eats-Printer-Portable.exe** - Executável portátil (recomendado para distribuição)
- **Link-Eats-Printer-Setup.exe** - Instalador completo (opcional)

## 📦 Como Distribuir

### Para Versão Portátil (Recomendado)

1. Após o build, vá para a pasta `dist/`
2. Localize o arquivo `Link-Eats-Printer-Portable.exe`
3. Compacte em um arquivo .zip ou .rar junto com um README simples
4. Distribua o arquivo compactado

**O usuário final só precisa:**
1. Descompactar o arquivo
2. Executar `Link-Eats-Printer-Portable.exe`
3. Pronto! Não precisa instalar nada

### Para Versão com Instalador

1. Distribua o arquivo `Link-Eats-Printer-Setup.exe`
2. O usuário executa o instalador
3. O aplicativo será instalado no sistema com atalhos automáticos

## 🔧 Método Manual (Passo a Passo)

Se preferir executar manualmente cada etapa:

### Passo 1: Instalar Dependências Node.js
```bash
npm install
```

### Passo 2: Compilar Motor de Impressão Python
```bash
npm run build:printer:win
```

### Passo 3: Gerar Executável Portátil
```bash
npm run build:win:portable
```

OU para gerar ambos (portátil + instalador):
```bash
npm run build:win:all
```

## 📁 Estrutura dos Arquivos Gerados

```
dist/
├── Link-Eats-Printer-Portable.exe    (Versão portátil - ~150MB)
└── Link-Eats-Printer-Setup.exe       (Instalador - ~150MB)
```

## ⚠️ Problemas Comuns

### Erro: "Python não encontrado"
- Reinstale o Python marcando "Add to PATH"
- Ou adicione manualmente o Python ao PATH do sistema

### Erro: "Node.js não encontrado"
- Instale o Node.js do site oficial
- Reinicie o terminal após a instalação

### Erro: "npm install falhou"
- Execute como administrador
- Limpe o cache: `npm cache clean --force`
- Tente novamente: `npm install`

### Build demora muito
- É normal! O processo pode levar 5-10 minutos
- O PyInstaller e electron-builder precisam compilar muitos arquivos

### Executável muito grande
- É normal! Aplicativos Electron incluem o Chrome e Node.js
- Tamanho esperado: 120-180 MB

## 🎯 Dicas de Distribuição

1. **Compacte o executável** - Use WinRAR ou 7-Zip para reduzir o tamanho
2. **Inclua um README** - Explique como usar o aplicativo
3. **Teste antes de distribuir** - Execute o .exe em outro computador
4. **Versione seus builds** - Mantenha controle das versões distribuídas

## 📝 Notas Importantes

- O executável gerado é **apenas para Windows**
- Não precisa instalar Node.js ou Python no computador do usuário final
- Todas as dependências já estão incluídas no executável
- O aplicativo cria uma pasta `user-data` para salvar configurações
- A primeira execução pode demorar um pouco mais

## 🆘 Suporte

Se encontrar problemas durante o build:
1. Verifique se todas as dependências estão instaladas
2. Execute o build como administrador
3. Verifique os logs de erro no terminal
4. Entre em contato com a equipe de desenvolvimento

---

**Desenvolvido por Link Eats** 🍔
