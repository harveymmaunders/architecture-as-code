import { Command } from 'commander';
import { Mock } from 'vitest';
import { getFormattedOutput, validate, validateDecorator, exitBasedOffOfValidationOutcome, validationEnrichmentTest } from '@finos/calm-shared';
import { mkdirp } from 'mkdirp';
import { writeFileSync } from 'fs';
import path from 'path';
import { runValidate, writeOutputFile, checkValidateOptions, ValidateOptions } from './validate';


const dummyArch = { dummy: 'arch' };
const dummyPattern = { dummy: 'pattern' };
const dummyArchOfAPattern = { '$schema': 'pattern.json', dummy: 'arch' };
const dummyArchOfCalmSchema = { '$schema': 'calm-schema.json', dummy: 'arch' };
const dummyCalmSchema = { '$id': 'calm-schema.json', dummy: 'calm schema' };
const dummyTimeline = { '$schema': 'calm-timeline-schema.json', dummy: 'timeline' };
const dummyCalmTimelineSchema = { '$id': 'calm-timeline-schema.json', dummy: 'calm timeline schema' };

const dummyDecorator = {
    'unique-id': 'finos-deployment-1',
    'type': 'deployment',
    'target': ['/calm/namespaces/finos/architectures/1/versions/1-0-0'],
    'applies-to': ['example-node'],
    'data': { 'status': 'completed' }
};

const mocks = vi.hoisted(() => ({
    validate: vi.fn(),
    validateDecorator: vi.fn(),
    getFormattedOutput: vi.fn(),
    exitBasedOffOfValidationOutcome: vi.fn(),
    initLogger: vi.fn(() => ({ error: vi.fn(), debug: vi.fn() })),
    processExit: vi.fn(),
    mkdirpSync: vi.fn(),
    writeFileSync: vi.fn(),
    parseDocumentLoaderConfig: vi.fn(),
    buildDocumentLoader: vi.fn(() => ({
        loadMissingDocument: mocks.loadMissingDocument
    })),
    loadSchemas: vi.fn(),
    getSchema: vi.fn(),
    loadMissingDocument: vi.fn()
}));

vi.mock('@finos/calm-shared', async () => ({
    ...(await vi.importActual('@finos/calm-shared')),
    validate: mocks.validate,
    validateDecorator: mocks.validateDecorator,
    getFormattedOutput: mocks.getFormattedOutput,
    exitBasedOffOfValidationOutcome: mocks.exitBasedOffOfValidationOutcome,
    initLogger: mocks.initLogger,
    loadSchemas: mocks.loadSchemas,
    buildDocumentLoader: mocks.buildDocumentLoader
}));

vi.mock('mkdirp', () => ({
    mkdirp: { sync: mocks.mkdirpSync },
}));

vi.mock('fs', () => ({
    ...vi.importActual('fs'),
    writeFileSync: mocks.writeFileSync,
}));

vi.mock('../cli', async () => ({
    ...(await vi.importActual('../cli')),
    parseDocumentLoaderConfig: mocks.parseDocumentLoaderConfig,
    buildSchemaDirectory: vi.fn(() => ({
        loadSchemas: mocks.loadSchemas,
        getSchema: mocks.getSchema
    })),
}));

describe('runValidate', () => {
    const fakeOutcome = { valid: true };

    beforeEach(() => {
        vi.resetAllMocks();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        process.exit = mocks.processExit as any;

        mocks.parseDocumentLoaderConfig.mockResolvedValue({});
        // Inline mock for loadMissingDocument
        mocks.loadMissingDocument.mockImplementation((filePath: string, _: string) => {
            if (filePath === 'arch.json') return Promise.resolve(dummyArch);
            if (filePath === 'arch-of-pattern.json') return Promise.resolve(dummyArchOfAPattern);
            if (filePath === 'arch-of-calm.json') return Promise.resolve(dummyArchOfCalmSchema);
            if (filePath === 'pattern.json') return Promise.resolve(dummyPattern);
            // Handle resolved absolute paths for $schema references
            if (filePath.endsWith('pattern.json')) return Promise.resolve(dummyPattern);
            if (filePath === 'timeline.json') return Promise.resolve(dummyTimeline);
            if (filePath === 'decorator.json') return Promise.resolve(dummyDecorator);
            return Promise.resolve();
        });
        mocks.getSchema.mockImplementation((schemaId: string) => {
            // Handle both relative and resolved absolute paths
            if (schemaId === 'calm-schema.json' || schemaId.endsWith('calm-schema.json')) return dummyCalmSchema;
            if (schemaId === 'calm-timeline-schema.json' || schemaId.endsWith('calm-timeline-schema.json')) return dummyCalmTimelineSchema;
            throw new Error(`Schema ${schemaId} not found`);
        });
        (validate as Mock).mockResolvedValue(fakeOutcome);
        (validateDecorator as Mock).mockResolvedValue(fakeOutcome);
        (getFormattedOutput as Mock).mockReturnValue('formatted output');
    });

    it('should process validation successfully with both architecture and pattern', async () => {
        const options: ValidateOptions = {
            architecturePath: 'arch.json',
            patternPath: 'pattern.json',
            metaSchemaPath: 'schemas',
            verbose: true,
            outputFormat: 'json',
            outputPath: 'out.json',
            strict: false,
        };


        await runValidate(options);

        expect(mocks.loadSchemas).toHaveBeenCalled();
        expect(mocks.loadMissingDocument).toHaveBeenCalledWith('arch.json', 'architecture');
        expect(mocks.loadMissingDocument).toHaveBeenCalledWith('pattern.json', 'pattern');
        expect(validate).toHaveBeenCalledWith(dummyArch, dummyPattern, undefined, expect.anything(), true);
        expect(getFormattedOutput).toHaveBeenCalledWith(fakeOutcome, 'json', expect.anything());
        expect(exitBasedOffOfValidationOutcome).toHaveBeenCalledWith(fakeOutcome, false);

        expect(mkdirp.sync).toHaveBeenCalledWith(path.dirname('out.json'));
        expect(writeFileSync).toHaveBeenCalledWith('out.json', 'formatted output');
    });

    it('should process validation successfully with architecture only', async () => {
        const options: ValidateOptions = {
            architecturePath: 'arch.json',
            patternPath: undefined,
            metaSchemaPath: 'schemas',
            verbose: true,
            outputFormat: 'json',
            outputPath: 'out.json',
            strict: false,
        };


        await runValidate(options);

        expect(mocks.loadSchemas).toHaveBeenCalled();
        expect(mocks.loadMissingDocument).toHaveBeenCalledWith('arch.json', 'architecture');
        expect(validate).toHaveBeenCalledWith(dummyArch, undefined, undefined, expect.anything(), true);
        expect(getFormattedOutput).toHaveBeenCalledWith(fakeOutcome, 'json', expect.anything());
        expect(exitBasedOffOfValidationOutcome).toHaveBeenCalledWith(fakeOutcome, false);

        expect(mkdirp.sync).toHaveBeenCalledWith(path.dirname('out.json'));
        expect(writeFileSync).toHaveBeenCalledWith('out.json', 'formatted output');
    });

    it('should process validation successfully with architecture only and architecture has a pattern', async () => {
        const options: ValidateOptions = {
            architecturePath: 'arch-of-pattern.json',
            patternPath: undefined,
            metaSchemaPath: 'schemas',
            verbose: true,
            outputFormat: 'json',
            outputPath: 'out.json',
            strict: false,
        };


        await runValidate(options);

        expect(mocks.loadSchemas).toHaveBeenCalled();
        // $schema reference is resolved to absolute path relative to architecture file
        const resolvedPatternPath = path.resolve(process.cwd(), 'pattern.json');
        expect(mocks.getSchema).toHaveBeenCalledWith(resolvedPatternPath);
        expect(mocks.loadMissingDocument).toHaveBeenCalledWith('arch-of-pattern.json', 'architecture');
        expect(mocks.loadMissingDocument).toHaveBeenCalledWith(resolvedPatternPath, 'pattern');
        expect(validate).toHaveBeenCalledWith(dummyArchOfAPattern, dummyPattern, undefined, expect.anything(), true);
        expect(getFormattedOutput).toHaveBeenCalledWith(fakeOutcome, 'json', expect.anything());
        expect(exitBasedOffOfValidationOutcome).toHaveBeenCalledWith(fakeOutcome, false);

        expect(mkdirp.sync).toHaveBeenCalledWith(path.dirname('out.json'));
        expect(writeFileSync).toHaveBeenCalledWith('out.json', 'formatted output');
    });

    it('should process validation successfully with architecture only and architecture references CALM schema', async () => {
        const options: ValidateOptions = {
            architecturePath: 'arch-of-calm.json',
            patternPath: undefined,
            metaSchemaPath: 'schemas',
            verbose: true,
            outputFormat: 'json',
            outputPath: 'out.json',
            strict: false,
        };


        await runValidate(options);

        expect(mocks.loadSchemas).toHaveBeenCalled();
        // $schema reference is resolved to absolute path relative to architecture file
        const resolvedSchemaPath = path.resolve(process.cwd(), 'calm-schema.json');
        expect(mocks.getSchema).toHaveBeenCalledWith(resolvedSchemaPath);
        expect(mocks.loadMissingDocument).toHaveBeenCalledWith('arch-of-calm.json', 'architecture');
        expect(mocks.loadMissingDocument).toHaveBeenCalledOnce();
        expect(validate).toHaveBeenCalledWith(dummyArchOfCalmSchema, dummyCalmSchema, undefined, expect.anything(), true);
        expect(getFormattedOutput).toHaveBeenCalledWith(fakeOutcome, 'json', expect.anything());
        expect(exitBasedOffOfValidationOutcome).toHaveBeenCalledWith(fakeOutcome, false);

        expect(mkdirp.sync).toHaveBeenCalledWith(path.dirname('out.json'));
        expect(writeFileSync).toHaveBeenCalledWith('out.json', 'formatted output');
    });

    it('should process validation successfully with pattern only', async () => {
        const options: ValidateOptions = {
            architecturePath: undefined,
            patternPath: 'pattern.json',
            metaSchemaPath: 'schemas',
            verbose: true,
            outputFormat: 'json',
            outputPath: 'out.json',
            strict: false,
        };


        await runValidate(options);

        expect(mocks.loadSchemas).toHaveBeenCalled();
        expect(mocks.loadMissingDocument).toHaveBeenCalledWith('pattern.json', 'pattern');
        expect(validate).toHaveBeenCalledWith(undefined, dummyPattern, undefined, expect.anything(), true);
        expect(getFormattedOutput).toHaveBeenCalledWith(fakeOutcome, 'json', expect.anything());
        expect(exitBasedOffOfValidationOutcome).toHaveBeenCalledWith(fakeOutcome, false);

        expect(mkdirp.sync).toHaveBeenCalledWith(path.dirname('out.json'));
        expect(writeFileSync).toHaveBeenCalledWith('out.json', 'formatted output');
    });

    it('should process validation successfully with timeline', async () => {
        const options: ValidateOptions = {
            architecturePath: undefined,
            patternPath: undefined,
            timelinePath: 'timeline.json',
            metaSchemaPath: 'schemas',
            verbose: true,
            outputFormat: 'json',
            outputPath: 'out.json',
            strict: false,
        };


        await runValidate(options);

        expect(mocks.loadSchemas).toHaveBeenCalled();
        // $schema reference is resolved to absolute path relative to architecture file
        const resolvedSchemaPath = path.resolve(process.cwd(), 'calm-timeline-schema.json');
        expect(mocks.getSchema).toHaveBeenCalledWith(resolvedSchemaPath);
        expect(mocks.loadMissingDocument).toHaveBeenCalledWith('timeline.json', 'timeline');
        expect(validate).toHaveBeenCalledWith(undefined, dummyCalmTimelineSchema, dummyTimeline, expect.anything(), true);
        expect(getFormattedOutput).toHaveBeenCalledWith(fakeOutcome, 'json', expect.anything());
        expect(exitBasedOffOfValidationOutcome).toHaveBeenCalledWith(fakeOutcome, false);

        expect(mkdirp.sync).toHaveBeenCalledWith(path.dirname('out.json'));
        expect(writeFileSync).toHaveBeenCalledWith('out.json', 'formatted output');
    });

    it('should process validation successfully with decorator only', async () => {
        const options: ValidateOptions = {
            decoratorPath: 'decorator.json',
            metaSchemaPath: 'schemas',
            verbose: false,
            outputFormat: 'json',
            outputPath: 'out.json',
            strict: false,
        };

        await runValidate(options);

        expect(mocks.loadSchemas).toHaveBeenCalled();
        expect(mocks.loadMissingDocument).toHaveBeenCalledWith('decorator.json', 'decorator');
        expect(validateDecorator).toHaveBeenCalledWith(dummyDecorator, expect.anything(), false);
        expect(validate).not.toHaveBeenCalled();
        expect(getFormattedOutput).toHaveBeenCalledWith(fakeOutcome, 'json', expect.anything());
        expect(exitBasedOffOfValidationOutcome).toHaveBeenCalledWith(fakeOutcome, false);
    });

    it('should call process.exit(1) when an error occurs', async () => {
        const options: ValidateOptions = {
            architecturePath: 'arch.json',
            patternPath: 'pattern.json',
            metaSchemaPath: 'schemas',
            verbose: true,
            outputFormat: 'json',
            outputPath: 'out.json',
            strict: false,
        };

        mocks.parseDocumentLoaderConfig.mockResolvedValue({});
        mocks.buildDocumentLoader.mockReturnValue({
            loadMissingDocument: vi.fn((filePath: string) => {
                if (filePath === 'arch.json') return dummyArch;
                if (filePath === 'pattern.json') return dummyPattern;
                return undefined;
            })
        });

        const error = new Error('Validation failed');
        (validate as Mock).mockRejectedValue(error);

        await runValidate(options);
        expect(mocks.processExit).toHaveBeenCalledWith(1);
    });
});

describe('writeOutputFile', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('should write output to file if output is provided', () => {
        const output = 'dir/out.txt';
        const content = 'some content';
        writeOutputFile(output, content);
        expect(mkdirp.sync).toHaveBeenCalledWith(path.dirname(output));
        expect(writeFileSync).toHaveBeenCalledWith(output, content);
    });

    it('should write output to stdout if no output is provided', () => {
        const content = 'stdout content';
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        writeOutputFile('', content);
        expect(stdoutSpy).toHaveBeenCalledWith(content);
        stdoutSpy.mockRestore();
    });
});


describe('checkValidateOptions', () => {
    const PATTERN_OPT = '-p, --pattern <file>';
    const ARCH_OPT = '-a, --architecture <file>';
    const TIMELINE_OPT = '--timeline <file>';
    const DECORATOR_OPT = '-d, --decorator <file>';

    function check(program: Command, options: object) {
        return () => checkValidateOptions(program, options, PATTERN_OPT, ARCH_OPT, TIMELINE_OPT, DECORATOR_OPT);
    }

    it('should call program.error if none of the required options are provided', () => {
        const program = new Command();
        vi.spyOn(program, 'error').mockImplementation((msg: string) => { throw new Error(msg); });
        expect(check(program, {})).toThrow(/one of the required options/);
    });

    it('should not call program.error if a pattern is provided', () => {
        const program = new Command();
        vi.spyOn(program, 'error').mockImplementation((msg: string) => { throw new Error(msg); });
        expect(check(program, { pattern: 'pattern.json' })).not.toThrow();
    });

    it('should not call program.error if an architecture is provided', () => {
        const program = new Command();
        vi.spyOn(program, 'error').mockImplementation((msg: string) => { throw new Error(msg); });
        expect(check(program, { architecture: 'arch.json' })).not.toThrow();
    });

    it('should not call program.error if a timeline is provided', () => {
        const program = new Command();
        vi.spyOn(program, 'error').mockImplementation((msg: string) => { throw new Error(msg); });
        expect(check(program, { timeline: 'timeline.json' })).not.toThrow();
    });

    it('should not call program.error if a decorator is provided', () => {
        const program = new Command();
        vi.spyOn(program, 'error').mockImplementation((msg: string) => { throw new Error(msg); });
        expect(check(program, { decorator: 'decorator.json' })).not.toThrow();
    });

    it('should call program.error if pattern and timeline are provided', () => {
        const program = new Command();
        vi.spyOn(program, 'error').mockImplementation((msg: string) => { throw new Error(msg); });
        expect(check(program, { pattern: 'pattern.json', timeline: 'timeline.json' })).toThrow(/cannot be used with either of the options/);
    });

    it('should call program.error if architecture and timeline are provided', () => {
        const program = new Command();
        vi.spyOn(program, 'error').mockImplementation((msg: string) => { throw new Error(msg); });
        expect(check(program, { architecture: 'arch.json', timeline: 'timeline.json' })).toThrow(/cannot be used with either of the options/);
    });

    it('should call program.error if decorator and architecture are provided', () => {
        const program = new Command();
        vi.spyOn(program, 'error').mockImplementation((msg: string) => { throw new Error(msg); });
        expect(check(program, { decorator: 'decorator.json', architecture: 'arch.json' })).toThrow(/cannot be used with/);
    });

    it('should call program.error if decorator and pattern are provided', () => {
        const program = new Command();
        vi.spyOn(program, 'error').mockImplementation((msg: string) => { throw new Error(msg); });
        expect(check(program, { decorator: 'decorator.json', pattern: 'pattern.json' })).toThrow(/cannot be used with/);
    });

    it('should call program.error if decorator and timeline are provided', () => {
        const program = new Command();
        vi.spyOn(program, 'error').mockImplementation((msg: string) => { throw new Error(msg); });
        expect(check(program, { decorator: 'decorator.json', timeline: 'timeline.json' })).toThrow(/cannot be used with/);
    });
});


describe('rewritePathWithIds', () => {
    const { rewritePathWithIds } = validationEnrichmentTest;

    const document = {
        nodes: [
            {
                'unique-id': 'api-producer',
                interfaces: [
                    {
                        'unique-id': 'producer-ingress',
                        port: 8080
                    },
                    {
                        'unique-id': 'http-config',
                        config: {
                            targets: [
                                { 'unique-id': 'target-a', url: 'a' },
                                { url: 'b' }
                            ]
                        }
                    }
                ]
            },
            {
                interfaces: [
                    {
                        port: 9090
                    }
                ]
            }
        ],
        meta: { id: 'root' }
    } as const;

    it('rewrites simple object paths unchanged', () => {
        expect(rewritePathWithIds('/meta/id', document)).toBe('/meta/id');
    });

    it('uses array unique-ids when present', () => {
        expect(rewritePathWithIds('/nodes/0/interfaces/0/port', document))
            .toBe('/nodes/api-producer/interfaces/producer-ingress/port');
    });

    it('falls back to array index when no unique-id is present', () => {
        expect(rewritePathWithIds('/nodes/1/interfaces/0/port', document))
            .toBe('/nodes/1/interfaces/0/port');
    });

    it('handles nested array segments combining ids and indexes', () => {
        expect(rewritePathWithIds('/nodes/0/interfaces/1/config/targets/1/url', document))
            .toBe('/nodes/api-producer/interfaces/http-config/config/targets/1/url');
    });

    it('returns undefined when pointer path is empty or data missing', () => {
        expect(rewritePathWithIds('', document)).toBeUndefined();
        expect(rewritePathWithIds('/anything', undefined)).toBeUndefined();
    });
});
